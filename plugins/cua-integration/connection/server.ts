import type {
  DialogAnswer,
  LauncherControl,
  LifecycleRequest,
  Recovery,
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
import type { ServiceStop } from "./service.ts";
import { PROTOCOL_VERSION, RuntimeSupervisor } from "./supervisor.ts";
import { failureCategory, resultCategory } from "./diagnostics.ts";
import {
  CHECK_APP,
  CHECK_TIMEOUT_MS,
  checkScript,
  documentEnvironment,
  evaluate,
  failed,
  nativePermission,
  documentName,
  newMarker,
  type CheckDocument,
  type CheckEnvironment,
  type CheckResult,
  type RuntimeVersion,
} from "./native-check.ts";

// How many lifecycle outcomes the launcher status keeps.
export const LIFECYCLE_HISTORY = 10;
// How long a script may run after the client abandoned its call.
export const ABANDON_GRACE_MS = 3000;
// How many runtimes one launcher keeps: the main loop and its subagents. Each
// caller has its own runtime, so no caller sees the bindings of another.
export const RUNTIME_LIMIT = 4;
// A **recovery**: after a runtime failure, the launcher stays connected, and
// the next call of that caller starts a new runtime. The launcher makes at
// most this many recoveries in a row. A call that returns a result ends the
// row, because it shows that a runtime works. A failure after the last
// recovery of a row stops the launcher, so a runtime that fails at each start
// does not start without end.
export const RECOVERY_LIMIT = 3;
// How long a call waits until each process of the failed runtime of its
// caller is gone. The value is the wait for a lease.
export const RECOVERY_WAIT_MS = 30000;
// The note of the first result after a recovery.
export const RECOVERED =
  "The Computer Use runtime of this caller failed, and this call ran in a new runtime. The JavaScript bindings of the earlier runtime are gone. A call that ran at the failure ended with its failure and an unknown effect, and the launcher did not repeat it. Observe each app again before further input to that app.";
// The note of the next result after a call that the client abandoned.
const ABANDONED =
  "The client cancelled an earlier call while it waited for app access. Steps of that script before the request may have run. Observe the current app state before further input.";
// The runtime key of the main loop. A subagent's key is its agent ID.
const MAIN = "";

// One caller's runtime and the client requests that it serves now.
type Runtime = {
  key: string;
  owner: RuntimeSupervisor;
  active: number;
  usedAt: number;
  starting: Promise<void>;
  // The start of the runtime that replaces this runtime after its failure.
  replacement?: Promise<Runtime>;
};
// The reason category of a runtime failure: the kind of its error.
function recoveryReason(error: Error): Recovery["reason"] {
  if (error instanceof RpcError) return "protocol";
  return error instanceof ConnectionError &&
    (error.kind === "timeout" ||
      error.kind === "transport" ||
      error.kind === "protocol")
    ? error.kind
    : "state";
}
// The recovery information of one launcher. It has two parts, and no other
// code holds either of them.
// - The counts and the recent recoveries of the launcher, which last as long
//   as the launcher.
// - The **pending information** of each caller: the notes that the next
//   result of that caller starts with, and the recovery of that caller for
//   which no new runtime started yet. It does not belong to a runtime, so it
//   stays when the launcher closes the runtime of that caller. A result that
//   a working runtime returns to the caller takes the notes, and the start of
//   a runtime of the caller completes the recovery. The end of the
//   conversation and the stop of the launcher drop the rest.
// The ledger holds the pending information of at most `callerLimit` callers.
// One more caller removes the information of the caller that got its first
// item earliest.
function recoveryLedger(callerLimit: number) {
  const totals = { count: 0, inRow: 0, recent: [] as Recovery[] };
  const pending = new Map<
    string,
    { notes: Set<string>; recovery?: Recovery }
  >();
  const entry = (key: string) => {
    let held = pending.get(key);
    if (!held) {
      held = { notes: new Set() };
      pending.set(key, held);
      for (const oldest of pending.keys()) {
        if (pending.size <= callerLimit) break;
        if (oldest !== key) pending.delete(oldest);
      }
    }
    return held;
  };
  return {
    // A runtime of this caller failed, or its start failed. Returns false
    // when the row is at its limit: this failure is then no recovery, and the
    // launcher stops.
    failed(key: string, error: Error): boolean {
      if (totals.inRow >= RECOVERY_LIMIT) return false;
      const recovery: Recovery = {
        at: new Date().toISOString(),
        reason: recoveryReason(error),
        caller: key === MAIN ? "main" : "subagent",
      };
      totals.count++;
      totals.inRow++;
      totals.recent.push(recovery);
      if (totals.recent.length > LIFECYCLE_HISTORY) totals.recent.shift();
      const held = entry(key);
      held.recovery = recovery;
      held.notes.add(RECOVERED);
      return true;
    },
    // Adds a note to the next result of this caller.
    note(key: string, text: string) {
      entry(key).notes.add(text);
    },
    // A runtime of this caller started.
    started(key: string) {
      const held = pending.get(key);
      if (!held?.recovery) return;
      held.recovery.restartedAt = new Date().toISOString();
      delete held.recovery;
      if (held.notes.size === 0) pending.delete(key);
    },
    // A working runtime returned a result, which ends the row of recoveries.
    worked() {
      totals.inRow = 0;
    },
    // Takes the notes of this caller for a result that reaches the client.
    take(key: string): string[] {
      const held = pending.get(key);
      if (!held) return [];
      const notes = [...held.notes];
      held.notes.clear();
      if (!held.recovery) pending.delete(key);
      return notes;
    },
    // The conversation ended. Its notes are of no use to the next
    // conversation, and its subagents do not return. The main loop continues,
    // so a recovery of it still waits for its new runtime.
    conversationEnded() {
      for (const [key, held] of pending) {
        held.notes.clear();
        if (key !== MAIN || !held.recovery) pending.delete(key);
      }
    },
    // The launcher stopped.
    clear() {
      pending.clear();
    },
    status() {
      return totals.count === 0
        ? undefined
        : {
            count: totals.count,
            inRow: totals.inRow,
            limit: RECOVERY_LIMIT,
            recent: totals.recent.map((item) => ({ ...item })),
          };
    },
  };
}

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
    > &
      Partial<Pick<LauncherControl, "checkRequest" | "serviceStopRequest">>;
    // How often the launcher checks for the Mod's answer while an approval waits.
    answerPollMs?: number;
    // How often the launcher checks for lifecycle events that the Mod relays.
    lifecyclePollMs?: number;
    // How long an abandoned call may run before the launcher stops its
    // runtime process.
    abandonGraceMs?: number;
    // How many caller runtimes the launcher keeps at one time.
    runtimeLimit?: number;
    // How long a call waits for the exit of the failed runtime of its caller.
    recoveryWaitMs?: number;
    // Creates the runtime of one caller. The main loop's runtime starts at
    // initialize; a subagent's runtime starts at its first call.
    createSupervisor(
      onPending: (pending: PendingRequest) => void,
      caller: { agentId?: string },
    ): RuntimeSupervisor;
    // The document of the native check, and the version of a runtime. The
    // defaults are a temporary TextEdit document and the launch diagnostics
    // of the runtime.
    checkEnvironment?: CheckEnvironment;
    runtimeVersion?: (owner: RuntimeSupervisor) => RuntimeVersion | undefined;
    // Makes one attempt to stop the Computer Use service, and resolves to
    // the result, or to undefined when the launcher knows no service bundle.
    stopService?: () => Promise<ServiceStop | undefined>;
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
  // The version of a runtime: its plugin and its packages.
  const versionOf =
    options.runtimeVersion ??
    ((owner: RuntimeSupervisor): RuntimeVersion | undefined => {
      const launch = owner.health().launch;
      return launch
        ? { pluginVersion: launch.pluginVersion, packages: launch.packages }
        : undefined;
    });
  // The native check that runs now, with its runtime, and the result of the
  // last check that finished. The result lives in this process only, so it
  // ends with the launcher.
  let checking: { id: string; owner?: RuntimeSupervisor } | undefined;
  let checkResult: CheckResult | undefined;
  // The recoveries of this launcher and the notes that wait for each caller.
  const ledger = recoveryLedger(options.runtimeLimit ?? RUNTIME_LIMIT);
  // A failed runtime stays the runtime of its caller until the next call of
  // that caller replaces it. Thus, the status shows the failure until then.
  const hasFailed = (runtime: Runtime) =>
    runtime.owner.health().state === "failed";
  const publish = () => {
    const recovery = ledger.status();
    const health = main()?.health();
    const owners = [
      ...[...runtimes.values()]
        .filter((runtime) => !hasFailed(runtime))
        .map((runtime) => runtime.owner),
      ...(checking?.owner ? [checking.owner] : []),
    ];
    const grants = main()?.grantStatus();
    const current = main() ? versionOf(main()!) : undefined;
    options.control?.publish({
      ...(current ? { runtimeVersion: current } : {}),
      ...(checking
        ? { nativeCheck: { id: checking.id, state: "running" as const } }
        : checkResult
          ? { nativeCheck: { id: checkResult.id, state: "finished" as const } }
          : {}),
      // A result of another runtime version never shows as current.
      nativePermission: nativePermission(checkResult, current),
      runtimeReady: health?.state === "ready",
      ...(health ? { runtimeGeneration: health.runtimeGeneration } : {}),
      ...(health?.launch
        ? {
            runtimeReview: {
              mode: health.launch.review.mode,
              unreviewedPackages: health.launch.review.unreviewedPackages,
            },
          }
        : {}),
      active: activeCalls,
      pending: owners.reduce((sum, owner) => sum + owner.pending().length, 0),
      runtimes: owners.length,
      ...(recovery ? { recovery } : {}),
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
  // Runtimes that closed and whose processes can still run. Launcher control
  // keeps the session until each of them has exited.
  const closing: Array<Promise<void>> = [];
  // The launcher stops the Computer Use service at two events (decision
  // record 0006), because the agent pointer of the service stays on the
  // screen while the service lives. The launcher never stops the service at
  // a turn end: the person decides when the service stops during a session.
  // - The command `/cua stop-service` of a person. The attempt needs no call
  //   of this launcher, because the person can want to stop a service that
  //   another product started. While a call of this launcher runs, the
  //   result is `in-use`, and no signal goes out.
  // - The stop of the launcher, after each of its runtime processes exited,
  //   and only when a call of the launcher used the service since the
  //   service last stopped at an attempt. A launcher with no such call
  //   never stops the service on its own.
  // The result goes to the status. A service that stays, or an attempt that
  // fails, changes no call and no teardown.
  // A use of the service is a call that reached dispatch in a runtime, also
  // a call of the native check. A call that the gate, the runtime limit, or
  // the lease refused sent no request to the service, so it is no use. The
  // launcher counts the uses. An attempt that stops the service covers only
  // the uses from before its start: a call that starts while the attempt
  // waits for the exit can start a new service, and its use stays.
  let serviceUses = 0;
  let usesCovered = 0;
  const serviceUse = () => {
    serviceUses++;
  };
  let serviceStops: Promise<void> = Promise.resolve();
  const attemptStop = (
    trigger: NonNullable<ServiceStop["trigger"]>,
    request?: string,
  ): Promise<void> => {
    serviceStops = serviceStops.then(async () => {
      if (
        trigger === "launcher-stop" &&
        (!options.stopService || serviceUses === usesCovered)
      )
        return;
      const observed = serviceUses;
      let result: ServiceStop | undefined;
      try {
        // The check of the calls and the start of the attempt are in one
        // synchronous step, so no call starts between them.
        result =
          trigger === "command" && activeCalls > 0
            ? { at: new Date().toISOString(), outcome: "in-use" }
            : await options.stopService?.();
        result ??= {
          at: new Date().toISOString(),
          outcome: "not-signalled",
          reason: "the launcher knows no service bundle",
        };
      } catch (error) {
        result = {
          at: new Date().toISOString(),
          outcome: "not-signalled",
          reason: error instanceof Error ? error.message : String(error),
        };
      }
      // Each other result leaves the uses, so the launcher stop tries again.
      if (result.outcome === "stopped" || result.outcome === "not-running")
        usesCovered = observed;
      try {
        options.control?.publish({
          nativeService: {
            ...result,
            trigger,
            ...(request === undefined ? {} : { request }),
          },
        });
      } catch {
        /* The attempt is over. The status fails closed. */
      }
    });
    return serviceStops;
  };
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
    ledger.clear();
    for (const runtime of runtimes.values()) {
      runtime.owner.close();
      closing.push(runtime.owner.exited());
    }
    runtimes.clear();
    if (checking?.owner) {
      checking.owner.close();
      closing.push(checking.owner.exited());
    }
    client.close();
    void Promise.all(closing)
      .catch(() => {})
      .then(() => attemptStop("launcher-stop"))
      .finally(() => {
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
    ledger.conversationEnded();
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
    let checkId: string | undefined;
    try {
      checkId = options.control.checkRequest?.();
    } catch {
      /* The Mod reports a check that did not start. */
    }
    if (checkId !== undefined) void nativeCheck(checkId);
    let stopId: string | undefined;
    try {
      stopId = options.control.serviceStopRequest?.();
    } catch {
      /* The Mod reports a request without a result. */
    }
    if (stopId !== undefined) void attemptStop("command", stopId);
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
  // A runtime of a caller failed. The failure belongs to that one runtime, so
  // the launcher stays connected: this is a recovery. The failed runtime
  // retired its generation and keeps its lease until its processes are gone.
  // The enabled state and the session grants belong to the launcher, so they
  // stay. A failure of the main runtime during initialization returns as the
  // initialize error instead. A start that fails is the same failure, also
  // when the factory fails before a supervisor exists.
  const recover = (key: string, error: Error) => {
    if (phase !== "initialized" && phase !== "ready") return;
    // The stop waits one turn of the event loop, so an in-flight call first
    // receives its error response.
    if (!ledger.failed(key, error)) setImmediate(stop);
    else tryPublish();
  };
  // Creates and wires the runtime of one caller, and makes it the runtime of
  // that caller.
  const createRuntime = (key: string): Runtime => {
    let owner: RuntimeSupervisor | undefined;
    try {
      owner = options.createSupervisor(
        (pending) => onPending(pending, owner!),
        key === MAIN ? {} : { agentId: key },
      );
    } catch (error) {
      // No supervisor exists that can report this failure. The runtime of
      // the caller stays as it was, so the next call tries again.
      recover(key, error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
    owner.onPendingClosed = (operationId) => {
      if (offered.delete(operationId)) offer();
    };
    owner.onGrantReused = tryPublish;
    owner.onDispatch = serviceUse;
    const runtime: Runtime = {
      key,
      owner,
      active: 0,
      usedAt: Date.now(),
      starting: owner.start(),
    };
    owner.onFailed = (error) => recover(key, error);
    runtimes.set(key, runtime);
    return runtime;
  };
  // Starts the runtime that replaces a failed runtime of the same caller. The
  // new runtime starts only after each process of the failed runtime is gone,
  // so it takes the lease only after that. It has another generation and no
  // binding of the failed runtime.
  const replace = async (old: Runtime): Promise<Runtime> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const gone = await Promise.race([
      old.owner.exited().then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(
          () => resolve(false),
          options.recoveryWaitMs ?? RECOVERY_WAIT_MS,
        );
      }),
    ]);
    clearTimeout(timer);
    if (!gone)
      throw new RpcError(
        -32000,
        "A process of the failed runtime of this caller still runs, so no new runtime started; this call did not run",
      );
    if (phase === "stopped")
      throw new RpcError(-32000, "Connection is not ready");
    // The failed runtime closed during the wait, for example at a transition.
    if (runtimes.get(old.key) !== old) return runtimeFor(old.key);
    const next = createRuntime(old.key);
    await next.starting;
    ledger.started(old.key);
    return next;
  };
  // Makes room for one more runtime. The runtime of a native check counts as
  // one runtime. At the limit, the least recently used subagent runtime
  // without a running call closes. Otherwise the new work fails.
  const admit = (work: "call" | "check") => {
    const count = runtimes.size + (checking?.owner ? 1 : 0);
    if (count < (options.runtimeLimit ?? RUNTIME_LIMIT)) return;
    const idle = [...runtimes.values()]
      .filter((other) => other.key !== MAIN && other.active === 0)
      .sort((a, b) => a.usedAt - b.usedAt)[0];
    if (!idle)
      throw new RpcError(
        -32000,
        `${count} CUA callers already run calls in their own runtimes; this ${work} did not run`,
      );
    retire(idle);
    report(
      `Subagent runtime closed to admit another caller; a later turn end of that subagent is skipped`,
    );
  };
  // The native check of /cua check. The launcher is the caller: no client
  // call exists, so no caller record exists, and the check never uses the
  // runtime of a caller. It runs one fixed script in a runtime of its own,
  // which no model code reaches, and that runtime closes at the end. The
  // check obeys each rule of a call: the /cua on gate, the lease of the
  // controlled resource, the approval boundary, and one use of its
  // identifier. It adds no automatic accept, and it never runs twice.
  const nativeCheck = async (id: string) => {
    if (checking || phase !== "ready") return;
    checking = { id };
    activeCalls++;
    tryPublish();
    const toolUseId = `cua-check:${id}`;
    const marker = newMarker();
    const name = documentName();
    let document: CheckDocument | undefined;
    let dialogs = 0;
    let owner: RuntimeSupervisor | undefined;
    let runtime: RuntimeVersion | undefined;
    let verdict: Pick<CheckResult, "accessibility" | "screenCapture"> & {
      closed: boolean;
    };
    try {
      options.control?.assertEnabled();
      admit("check");
      const created = options.createSupervisor((pending) => {
        onPending(pending, created);
        dialogs++;
      }, {});
      owner = created;
      checking.owner = created;
      created.onPendingClosed = (operationId) => {
        if (offered.delete(operationId)) offer();
      };
      created.onGrantReused = tryPublish;
      created.onDispatch = serviceUse;
      await created.start();
      runtime = versionOf(created);
      if (!runtime) throw new Error("The runtime reported no version");
      tryPublish();
      const result = await created.call(
        {
          sessionId: options.sessionId,
          turnId: toolUseId,
          toolUseId,
          runtimeGeneration: created.health().runtimeGeneration,
        },
        "js",
        // The script names the document by its file name. The marker is in
        // the document only.
        { code: checkScript(name), timeout_ms: CHECK_TIMEOUT_MS },
        // The document opens only while this runtime holds the lease.
        async () => {
          document = await (
            options.checkEnvironment ?? documentEnvironment()
          ).open(name, marker);
        },
      );
      verdict = evaluate(result, marker, declined.has(toolUseId));
    } catch (error) {
      const capability = failed(error);
      verdict = {
        accessibility: capability,
        screenCapture: capability,
        closed: false,
      };
    }
    declined.delete(toolUseId);
    // The file goes at each end of the check. A window that did not close
    // can stay, and the result says so.
    let fileRemoved = true;
    try {
      fileRemoved = document?.remove() ?? true;
    } catch {
      fileRemoved = false;
    }
    const sessionGrant = owner?.grantStatus().reusedGrants ?? 0;
    if (owner) {
      owner.close();
      closing.push(owner.exited());
    }
    checkResult = {
      id,
      app: CHECK_APP,
      at: new Date().toISOString(),
      ...(runtime ? { runtime } : {}),
      accessibility: verdict.accessibility,
      screenCapture: verdict.screenCapture,
      approvals: { dialogs, sessionGrant },
      ...(document ? { document: name } : {}),
      window: !document
        ? "not-opened"
        : verdict.closed
          ? "closed"
          : "left-open",
      fileRemoved,
    };
    checking = undefined;
    activeCalls--;
    tryPublish();
  };
  // The runtime of a caller. It starts at the first call of the caller, and
  // another one starts at the first call after a failure. Calls that arrive
  // during a start wait for that one start.
  const runtimeFor = async (key: string): Promise<Runtime> => {
    let runtime = runtimes.get(key);
    if (runtime && hasFailed(runtime)) {
      const old = runtime;
      old.replacement ??= replace(old).finally(() => {
        // A start that did not happen leaves the next call to try again.
        if (runtimes.get(key) === old) delete old.replacement;
        tryPublish();
      });
      return old.replacement;
    }
    if (!runtime) {
      admit("call");
      runtime = createRuntime(key);
      await runtime.starting;
      ledger.started(key);
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
          instructions: runtime.owner.instructions(),
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
          // A result of a runtime that works ends a row of recoveries, and
          // it starts with the notes of its caller. An error result of
          // `js_reset` fails its runtime. Such a result changes neither, so
          // the note and the row wait for the runtime that replaces it.
          if (!hasFailed(runtime)) {
            ledger.worked();
            const notes = abandoned.has(request.id)
              ? []
              : ledger.take(runtime.key);
            if (notes.length > 0)
              result = {
                ...result,
                content: [
                  ...notes.map((text) => ({ type: "text", text })),
                  ...result.content,
                ],
              };
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
        const { toolUseId, runtime } = inFlight.get(request.id) ?? {};
        inFlight.delete(request.id);
        clearTimeout(graceTimers.get(request.id));
        graceTimers.delete(request.id);
        if (toolUseId !== undefined) abandonedCalls.delete(toolUseId);
        if (abandoned.has(request.id) && runtime && phase !== "stopped")
          ledger.note(runtime.key, ABANDONED);
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
