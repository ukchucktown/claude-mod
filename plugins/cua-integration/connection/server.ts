import type {
  DialogAnswer,
  LauncherControl,
  LifecycleRequest,
} from "./control.ts";
import type { Readable, Writable } from "node:stream";
import { choiceDecision } from "../policy/native-approval.ts";
import type { Json, PendingRequest } from "../contracts.ts";
import {
  ConnectionError,
  nonempty,
  object,
  RpcError,
  RpcStream,
  rpcId,
  type Request,
} from "./protocol.ts";
import { PROTOCOL_VERSION, RuntimeSupervisor } from "./supervisor.ts";
import { failureCategory, resultCategory } from "./diagnostics.ts";

// How many lifecycle outcomes the launcher status keeps.
export const LIFECYCLE_HISTORY = 10;
// How long a script may run after the client abandoned its call.
export const ABANDON_GRACE_MS = 3000;
// How many runtimes one launcher keeps: the main loop and its subagents. Each
// caller has its own runtime, so no caller sees the bindings of another.
export const RUNTIME_LIMIT = 4;
// The runtime key of the main loop. A subagent's key is its agent ID.
const MAIN = "";

// One caller's runtime and the client requests that it serves now.
type Runtime = {
  key: string;
  owner: RuntimeSupervisor;
  active: number;
  usedAt: number;
  starting: Promise<void>;
};

// Stdio is the only client boundary. No HTTP routes or unauthenticated bridge.
export function serve(
  input: Readable,
  output: Writable,
  options: {
    sessionId: string;
    control?: Pick<
      LauncherControl,
      | "assertEnabled"
      | "publish"
      | "close"
      | "offer"
      | "answers"
      | "caller"
      | "lifecycle"
    >;
    // How often the launcher checks for the Mod's answer while an approval waits.
    answerPollMs?: number;
    // How often the launcher checks for lifecycle events that the Mod relays.
    lifecyclePollMs?: number;
    // How long an abandoned call may run before the launcher stops its
    // runtime process.
    abandonGraceMs?: number;
    // How many caller runtimes the launcher keeps at one time.
    runtimeLimit?: number;
    // Creates the runtime of one caller. The main loop's runtime starts at
    // initialize; a subagent's runtime starts at its first call.
    createSupervisor(
      onPending: (pending: PendingRequest) => void,
      caller: { agentId?: string },
    ): RuntimeSupervisor;
    // Called once when the server stops, so the process can exit.
    onStopped?: () => void;
  },
) {
  const client = new RpcStream(input, output);
  const runtimes = new Map<string, Runtime>();
  const main = () => runtimes.get(MAIN)?.owner;
  let phase:
    | "new"
    | "initializing"
    | "initialized"
    | "ready"
    | "failed"
    | "stopped" = "new";
  // Client requests that have not received a response yet.
  let activeCalls = 0;
  const publish = () => {
    const health = main()?.health();
    const owners = [...runtimes.values()].map((runtime) => runtime.owner);
    const grants = main()?.grantStatus();
    options.control?.publish({
      runtimeReady: health?.state === "ready",
      ...(health ? { runtimeGeneration: health.runtimeGeneration } : {}),
      active: activeCalls,
      pending: owners.reduce((sum, owner) => sum + owner.pending().length, 0),
      runtimes: owners.length,
      ...(grants
        ? {
            ...grants,
            reusedGrants: owners.reduce(
              (sum, owner) => sum + owner.grantStatus().reusedGrants,
              0,
            ),
          }
        : {}),
    });
  };
  const tryPublish = () => {
    try {
      publish();
    } catch {
      /* Status failure cannot change a call, decision, or teardown. */
    }
  };
  // Calls whose user answered an approval with decline or cancel, so that the
  // status can report the tool error that follows as a refusal.
  const declined = new Set<string>();
  // Client requests that have not received a response, with the tool-use ID
  // and the runtime of each tool call.
  const inFlight = new Map<
    Request["id"],
    { toolUseId?: string; runtime?: Runtime }
  >();
  // Tool calls that the client cancelled while they waited for app access.
  // MCP asks the receiver not to answer a cancelled request. The script can
  // catch the refusal and go on, so an abandoned call gets no further
  // approval, and a call that does not end within the grace period stops its
  // runtime.
  const abandoned = new Set<Request["id"]>();
  const abandonedCalls = new Set<string>();
  // Running calls that the client cancelled. Their runtime stops, and the
  // client receives no response.
  const cancelled = new Set<Request["id"]>();
  const graceTimers = new Map<Request["id"], ReturnType<typeof setTimeout>>();
  // The conversation that the last registered call ran in. A clear or resume
  // starts another conversation in the same Claude Code process.
  let conversation: string | undefined;
  // When the launcher last moved away from each conversation. A call record
  // written before that time belongs to the retired activation, even when the
  // same conversation returns through /resume.
  const retired = new Map<string, number>();
  // The number of conversation transitions. A call admitted under one count
  // cannot run under a later one, also when it waited for its runtime.
  let transitions = 0;
  // A note for the next result after a call that the client abandoned.
  let recovery: string | undefined;
  // Runtimes that closed and whose processes can still run. Launcher control
  // keeps the session until each of them has exited.
  const closing: Array<Promise<void>> = [];
  // A stopped server closes its output, so the client sees a disconnect
  // instead of a server that silently stops answering. Launcher control keeps
  // the session until every runtime process has exited, so another launcher
  // cannot take the session while an old runtime can still act.
  const stop = () => {
    if (phase === "stopped") return;
    phase = "stopped";
    for (const timer of graceTimers.values()) clearTimeout(timer);
    clearInterval(poll);
    clearInterval(lifecyclePoll);
    offered.clear();
    for (const runtime of runtimes.values()) {
      runtime.owner.close();
      closing.push(runtime.owner.exited());
    }
    runtimes.clear();
    client.close();
    void Promise.all(closing).finally(() => {
      try {
        options.control?.close();
      } catch {
        /* A telemetry failure cannot prevent transport teardown. */
      } finally {
        options.onStopped?.();
      }
    });
  };
  // Closes the runtime of one subagent. The main loop's runtime closes only
  // with the server. A closed runtime keeps its lease until its process exits.
  const retire = (runtime: Runtime) => {
    if (runtime.key === MAIN || runtimes.get(runtime.key) !== runtime) return;
    runtimes.delete(runtime.key);
    runtime.owner.close();
    closing.push(runtime.owner.exited());
    tryPublish();
  };
  client.onFailure = () => stop();
  // The Mod presents approvals. The launcher publishes each pending request
  // through launcher control and polls for the Mod's answer. The supervisor
  // owns approval expiry and pauses the execution deadline; when an approval
  // closes, onPendingClosed withdraws its offer. The original request stays
  // intact in its pending record, in the runtime that received it.
  const offered = new Map<
    string,
    { pending: PendingRequest; owner: RuntimeSupervisor }
  >();
  let poll: ReturnType<typeof setInterval> | undefined;
  // The most recent answers, oldest first, as the status reports them.
  const dialogAnswers: DialogAnswer[] = [];
  const offer = () => {
    options.control!.offer(
      [...offered.values()].map(({ pending, owner }) => owner.offer(pending)),
    );
    if (offered.size > 0 && !poll)
      poll = setInterval(collect, options.answerPollMs ?? 100);
    if (offered.size === 0 && poll) {
      clearInterval(poll);
      poll = undefined;
    }
    tryPublish();
  };
  const collect = () => {
    let answers: ReturnType<LauncherControl["answers"]> = [];
    try {
      answers = options.control!.answers();
    } catch {
      /* The approval timeout still cancels an unreadable answer. */
    }
    for (const { operationId, choice, approver } of answers) {
      const entry = offered.get(operationId);
      if (!entry) continue;
      // Who answered each dialog, for a record. No decision depends on it.
      dialogAnswers.push({
        at: new Date().toISOString(),
        operationId,
        choice,
        approver,
      });
      if (dialogAnswers.length > LIFECYCLE_HISTORY) dialogAnswers.shift();
      try {
        options.control!.publish({ dialogAnswers: [...dialogAnswers] });
      } catch {
        /* The answer still applies; the status fails closed. */
      }
      const { pending, owner } = entry;
      if (choice === "decline" || choice === "cancel")
        declined.add(pending.caller.toolUseId);
      try {
        owner.answer(pending, choiceDecision(choice));
      } catch {
        // The supervisor cancels a request whose answer it refused.
        try {
          owner.answer(pending, { action: "cancel" });
        } catch {
          /* Expired execution cannot receive a late answer. */
        }
      }
    }
  };
  // The launcher keeps the most recent outcomes, so a later event does not
  // hide how an earlier one ended.
  const history: Array<{ at: string; outcome: string }> = [];
  const report = (outcome: string) => {
    history.push({ at: new Date().toISOString(), outcome });
    if (history.length > LIFECYCLE_HISTORY) history.shift();
    try {
      options.control?.publish({ lifecycle: [...history] });
    } catch {
      /* The outcome stays in the launcher; status fails closed. */
    }
  };
  // A clear or resume of the conversation that ran the last calls. The event
  // can come from the Mod or from the first call of the next conversation. A
  // /resume can return to an earlier conversation under its old session ID;
  // that is another transition. Subagent runtimes belong to the old
  // conversation, so they close. The supervisor of the main loop cancels
  // approvals and retires the old generation before this function first
  // awaits. Resolves to the outcome to report, or undefined when nothing
  // happened.
  const transition = (
    reason: string,
    endedConversation: string,
  ): Promise<string | undefined> => {
    retired.set(endedConversation, Date.now());
    const owner = main();
    if (conversation !== endedConversation || !owner)
      return Promise.resolve(undefined);
    conversation = undefined;
    transitions++;
    const subagents = [...runtimes.values()].filter(
      (runtime) => runtime.key !== MAIN,
    );
    for (const runtime of subagents) retire(runtime);
    return owner
      .lifecycle({
        type: "session.end",
        sessionId: endedConversation,
        reason,
      })
      .then((outcome) =>
        subagents.length === 0
          ? outcome
          : `${outcome}; ${subagents.length} subagent runtime${subagents.length === 1 ? "" : "s"} closed`,
      );
  };
  // Outcomes reach the status in the order that the events arrived, also
  // when a later event finishes first.
  let reports: Promise<unknown> = Promise.resolve();
  const reportInOrder = (outcome: Promise<string | undefined>) => {
    reports = reports
      .then(() => outcome)
      .then((value) => {
        if (value !== undefined) report(value);
      })
      .catch(() => {});
  };
  // A turn end reaches the runtime of the caller that ran the turn. A
  // subagent's runtime closes after its turn end when no call of it runs.
  const turnEnd = (
    request: Extract<LifecycleRequest, { type: "turn.complete" }>,
  ): Promise<string> => {
    const runtime = runtimes.get(request.agentId ?? MAIN);
    if (!runtime)
      return Promise.resolve(
        "Turn end skipped: this caller has no runtime, so no call of this turn ran here",
      );
    return runtime.owner
      .lifecycle({ ...request, sessionId: options.sessionId })
      .then((outcome) => {
        if (runtime.key === MAIN || runtime.active > 0) return outcome;
        retire(runtime);
        return `${outcome}; subagent runtime closed`;
      });
  };
  const lifecyclePoll = setInterval(() => {
    if (phase !== "ready" || !main() || !options.control) return;
    let requests: LifecycleRequest[] = [];
    try {
      requests = options.control.lifecycle();
    } catch {
      /* The next poll retries. A missed turn end leaves cleanup unconfirmed. */
    }
    // Each event reaches its supervisor at once, in the order read. A turn
    // end takes its turn record before a later transition clears the turns,
    // and the supervisor orders the deliveries. A transition does not wait
    // behind an earlier turn end, which can wait behind the very approval that
    // the transition must cancel.
    for (const request of requests)
      reportInOrder(
        request.type === "session.end"
          ? transition(request.reason, request.conversation)
          : turnEnd(request),
      );
  }, options.lifecyclePollMs ?? 100);
  lifecyclePoll.unref();
  // Without launcher control no presentation exists. The supervisor cancels
  // the original request when this throws.
  const onPending = (pending: PendingRequest, owner: RuntimeSupervisor) => {
    if (!options.control) throw new Error("No approval presentation");
    if (abandonedCalls.has(pending.caller.toolUseId))
      throw new Error("The client abandoned this call");
    offered.set(pending.operationId, { pending, owner });
    try {
      offer();
    } catch (error) {
      offered.delete(pending.operationId);
      throw error;
    }
  };
  // Creates and wires the runtime of one caller. A runtime that fails after
  // its start stops the server, as an uncertain runtime state requires.
  const createRuntime = (key: string): Runtime => {
    let owner: RuntimeSupervisor | undefined;
    owner = options.createSupervisor(
      (pending) => onPending(pending, owner!),
      key === MAIN ? {} : { agentId: key },
    );
    owner.onPendingClosed = (operationId) => {
      if (offered.delete(operationId)) offer();
    };
    owner.onGrantReused = tryPublish;
    const created = owner;
    const runtime: Runtime = {
      key,
      owner,
      active: 0,
      usedAt: Date.now(),
      starting: owner.start().then(() => {
        // A runtime failure after initialization stops the server, so the
        // client sees a disconnect. The stop waits one turn of the event
        // loop, so an in-flight call first receives its error response.
        created.onFailed = () => {
          if (phase === "initialized" || phase === "ready") setImmediate(stop);
        };
      }),
    };
    runtimes.set(key, runtime);
    return runtime;
  };
  // The runtime of a caller, started at its first call. At the limit, the
  // least recently used subagent runtime without a running call closes.
  const runtimeFor = async (key: string): Promise<Runtime> => {
    let runtime = runtimes.get(key);
    if (!runtime) {
      if (runtimes.size >= (options.runtimeLimit ?? RUNTIME_LIMIT)) {
        const idle = [...runtimes.values()]
          .filter((other) => other.key !== MAIN && other.active === 0)
          .sort((a, b) => a.usedAt - b.usedAt)[0];
        if (!idle)
          throw new RpcError(
            -32000,
            `${runtimes.size} CUA callers already run calls in their own runtimes; this call did not run`,
          );
        retire(idle);
        report(
          `Subagent runtime closed to admit another caller; a later turn end of that subagent is skipped`,
        );
      }
      runtime = createRuntime(key);
      try {
        await runtime.starting;
      } catch (error) {
        if (runtimes.get(key) === runtime) runtimes.delete(key);
        runtime.owner.close();
        throw error;
      }
      tryPublish();
    }
    await runtime.starting;
    return runtime;
  };
  async function dispatch(request: Request): Promise<unknown> {
    const params = request.params ?? {};
    if (request.method === "ping") return {};
    // Claude probes this extension before initialize. Never forward it to the
    // provider, which exits on it. Report unsupported instead of fake success.
    if (request.method === "server/discover")
      throw new RpcError(
        -32601,
        "server/discover is unsupported; initialize with MCP",
      );
    if (request.method === "initialize") {
      if (phase !== "new")
        throw new RpcError(-32600, "Connection already initialized");
      if (
        !object(params) ||
        params.protocolVersion !== PROTOCOL_VERSION ||
        !object(params.capabilities) ||
        !object(params.clientInfo) ||
        !nonempty(params.clientInfo.name) ||
        !nonempty(params.clientInfo.version)
      ) {
        phase = "failed";
        throw new RpcError(
          -32602,
          "Require supported protocol and client identity",
        );
      }
      phase = "initializing";
      let runtime: Runtime | undefined;
      try {
        runtime = createRuntime(MAIN);
        await runtime.starting;
        phase = "initialized";
        publish();
        return {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: "claude-cua-owner", version: "0.1.0" },
          instructions: runtime.owner.serverInfo()?.instructions,
        };
      } catch (error) {
        // A failure during initialization returns as the initialize error.
        phase = "failed";
        try {
          options.control?.publish({
            runtimeReady: false,
            lastCall: "failed",
            error:
              error instanceof Error ? error.message : "Initialization failed",
            failure: failureCategory(error, "initialize"),
          });
        } catch {
          /* Preserve the initialization error. */
        }
        runtime?.owner.close();
        throw error;
      }
    }
    const owner = main();
    if (phase !== "ready" || !owner)
      throw new RpcError(-32000, "Connection is not ready");
    if (request.method === "tools/list") {
      if (!object(params) || Object.keys(params).some((key) => key !== "_meta"))
        throw new RpcError(-32602, "Unsupported tools/list parameters");
      // The provider marks `js` read-only, although its scripts click and type.
      // A host that trusts that hint can skip its own permission prompt.
      return {
        tools: owner
          .catalog()
          .filter((tool) => tool.name !== "turn_ended")
          .map((tool) =>
            tool.name === "js"
              ? {
                  ...tool,
                  annotations: {
                    ...(object(tool.annotations) ? tool.annotations : {}),
                    readOnlyHint: false,
                    destructiveHint: true,
                    openWorldHint: true,
                  },
                }
              : tool,
          ),
      };
    }
    if (request.method === "tools/call") {
      // MCP makes arguments optional. An omitted field means no arguments; an
      // explicit non-object value is still invalid.
      const args =
        object(params) && params.arguments === undefined
          ? {}
          : object(params)
            ? params.arguments
            : undefined;
      if (
        !object(params) ||
        !nonempty(params.name) ||
        !object(args) ||
        Object.keys(params).some(
          (key) => !["name", "arguments", "_meta"].includes(key),
        ) ||
        !object(params._meta) ||
        !nonempty(params._meta["claudecode/toolUseId"])
      )
        throw new RpcError(
          -32602,
          "A valid tool payload and Claude Code tool-use identity are required",
        );
      // Session identity is supplied by the host, not inferred from user code.
      // The Mod records the turn and agent of each call before the host sends
      // it. A call without a record has no known caller. The launcher does
      // not let it stand in for the main loop, because a subagent's call would
      // then run in the main loop's runtime.
      const toolUseId = params._meta["claudecode/toolUseId"];
      const flight = { toolUseId } as { toolUseId: string; runtime?: Runtime };
      inFlight.set(request.id, flight);
      options.control?.assertEnabled();
      const record = options.control?.caller(toolUseId);
      if (options.control && !record)
        throw new RpcError(
          -32000,
          "The Mod recorded no caller for this call, and the launcher does not guess one; the call did not run",
        );
      if (record) {
        const retiredAt = retired.get(record.conversation);
        if (retiredAt !== undefined && record.createdAt < retiredAt)
          throw new RpcError(
            -32000,
            "This call was recorded before its conversation ended",
          );
        // A clear or resume whose event did not reach the launcher.
        if (conversation !== undefined && conversation !== record.conversation)
          reportInOrder(transition("changed", conversation));
        conversation = record.conversation;
      }
      // A call of the next conversation can arrive while this call waits for
      // its runtime, and its transition resets the bindings. The generation
      // that this call reads after the wait would then be the new one.
      const admitted = transitions;
      const runtime = await runtimeFor(record?.agentId ?? MAIN);
      if (transitions !== admitted)
        throw new RpcError(
          -32000,
          "This call was recorded before its conversation ended",
        );
      flight.runtime = runtime;
      runtime.active++;
      runtime.usedAt = Date.now();
      try {
        const generation = runtime.owner.health().runtimeGeneration;
        await runtime.owner.ready();
        options.control?.assertEnabled();
        activeCalls++;
        try {
          options.control?.publish({ lastCall: "active" });
          publish();
          let result = await runtime.owner.call(
            {
              sessionId: options.sessionId,
              turnId: record?.turnId ?? toolUseId,
              toolUseId,
              ...(record?.agentId === undefined
                ? {}
                : { agentId: record.agentId }),
              runtimeGeneration: generation,
            },
            params.name,
            args as Record<string, Json>,
          );
          if (recovery !== undefined && !abandoned.has(request.id)) {
            result = {
              ...result,
              content: [{ type: "text", text: recovery }, ...result.content],
            };
            recovery = undefined;
          }
          try {
            options.control?.publish({
              lastCall: result.isError ? "failed" : "completed",
              error: result.isError
                ? "The runtime returned a tool error; prior effects may remain."
                : "",
              failure: result.isError
                ? resultCategory(result, declined.has(toolUseId))
                : "",
            });
          } catch {
            /* Preserve observations after execution. The control gate now fails closed. */
          }
          return result;
        } catch (error) {
          try {
            options.control?.publish({
              lastCall: "failed",
              error: error instanceof Error ? error.message : "Call failed",
              failure: failureCategory(error),
            });
          } catch {
            /* Preserve the execution error. */
          }
          throw error;
        } finally {
          declined.delete(toolUseId);
          activeCalls--;
        }
      } finally {
        runtime.active--;
        tryPublish();
      }
    }
    throw new RpcError(-32601, `Unsupported method: ${request.method}`);
  }
  client.onRequest = (request) => {
    inFlight.set(request.id, {});
    void dispatch(request)
      .finally(() => {
        const toolUseId = inFlight.get(request.id)?.toolUseId;
        inFlight.delete(request.id);
        clearTimeout(graceTimers.get(request.id));
        graceTimers.delete(request.id);
        if (toolUseId !== undefined) abandonedCalls.delete(toolUseId);
        if (abandoned.has(request.id))
          recovery =
            "The client cancelled an earlier call while it waited for app access. Steps of that script before the request may have run. Observe the current app state before further input.";
      })
      .then((result) => {
        if (!abandoned.delete(request.id) && !cancelled.delete(request.id))
          client.result(request.id, result);
      })
      .catch((error: unknown) => {
        if (abandoned.delete(request.id) || cancelled.delete(request.id))
          return;
        try {
          client.error(
            request.id,
            error instanceof RpcError ? error.code : -32000,
            error instanceof Error ? error.message : "Connection failed",
            error instanceof RpcError
              ? error.data
              : error instanceof ConnectionError
                ? error.details
                : undefined,
          );
        } catch {
          /* Client already disconnected. */
        }
      });
  };
  client.onNotification = (notification) => {
    if (
      notification.method === "notifications/initialized" &&
      phase === "initialized"
    )
      phase = "ready";
    // MCP lets a cancellation arrive after its request finished, and a receiver
    // ignores one for an unknown or finished request. A call that waits for
    // app access is cancelled through its approval: the runtime receives
    // cancel and ends the call. The runtime has no supported way to stop a
    // running script, so cancelling a call that runs stops its runtime
    // process. A subagent's runtime closes alone; the main loop's runtime
    // closes with the server.
    if (notification.method === "notifications/cancelled") {
      const params = notification.params;
      const requestId = object(params) ? params.requestId : undefined;
      if (!rpcId(requestId) || !inFlight.has(requestId)) return;
      const { toolUseId, runtime } = inFlight.get(requestId)!;
      const end = () =>
        runtime && runtime.key !== MAIN ? retire(runtime) : stop();
      const waiting = (runtime?.owner.pending() ?? []).filter(
        (pending) =>
          toolUseId !== undefined && pending.caller.toolUseId === toolUseId,
      );
      if (waiting.length === 0) {
        cancelled.add(requestId);
        end();
        return;
      }
      abandoned.add(requestId);
      abandonedCalls.add(toolUseId!);
      runtime!.owner.abandon(toolUseId!);
      graceTimers.set(
        requestId,
        setTimeout(end, options.abandonGraceMs ?? ABANDON_GRACE_MS),
      );
      for (const pending of waiting)
        try {
          runtime!.owner.answer(pending, { action: "cancel" });
        } catch {
          /* The approval already closed. */
        }
    }
  };
  return { close: stop };
}
