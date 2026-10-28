import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import type {
  Caller,
  Decision,
  Json,
  LifecycleEvent,
  PendingRequest,
  ServerRequest,
  ToolResult,
} from "../contracts.ts";
import type { ConnectionOwner } from "./owner.ts";
import type { SessionGrant, SessionGrants } from "../policy/grants.ts";
import {
  approvalOffer,
  nativeApproval,
  nativeDecision,
  type ApprovalOffer,
  type Availability,
  type NativeApproval,
} from "../policy/native-approval.ts";
import type { LaunchSpec } from "./launch.ts";
import {
  CONNECTION_ENV,
  descendants,
  OWNERSHIP_ENV,
  OwnershipError,
  type Lease,
  type ResourceOwnership,
} from "./ownership.ts";
import {
  ConnectionError,
  DEFAULT_DEADLINE_MS,
  MAX_DEADLINE_MS,
  nonempty,
  object,
  RpcStream,
  type DeadlineControl,
  type Request,
} from "./protocol.ts";
import {
  validateArguments,
  validateResult,
  validateTools,
  type Tool,
} from "./tool-contracts.ts";

export const PROTOCOL_VERSION = "2025-11-25";
export type RuntimeState =
  | "discoverable"
  | "initialized"
  | "ready"
  | "failed"
  | "stopped";
export type SupervisorOptions = {
  sessionId: string;
  deadlineMs?: number;
  beforeDispatch?: () => void;
  approvalTimeoutMs?: number;
  // The deadline for one turn_ended delivery. Expiry fails the runtime, as any
  // other deadline does, because the runtime's state is then unknown.
  cleanupDeadlineMs?: number;
  // How long a call of the previous conversation may run after a transition
  // before the runtime fails.
  transitionGraceMs?: number;
  onPending?: (request: PendingRequest) => void;
  // The session grants of the launcher. Without them every request asks, and
  // a dialog offers one-time access only.
  grants?: SessionGrants;
  // The lease of the controlled resource. Each call and turn end of this
  // runtime holds it, and the native guard refuses native requests without
  // it. Without a lease the guard refuses every native request.
  ownership?: ResourceOwnership;
  // How many calls of this runtime can wait behind the running call.
  queueLimit?: number;
  // The native session identity of this runtime connection. A random
  // identity when absent.
  connection?: string;
};
type Execution = {
  id: string;
  caller: Caller;
  token: string;
  deadline: DeadlineControl;
};
// The transport deadline for a js call covers its requested execution time
// plus this margin for result delivery.
export const JS_DEADLINE_MARGIN_MS = 30000;
export const CLEANUP_DEADLINE_MS = 10000;
export const TRANSITION_GRACE_MS = 3000;
// How long a stopped runtime has to exit after SIGTERM before SIGKILL.
export const STOP_GRACE_MS = 1000;
// How many calls of one runtime can wait behind its running call. A call over
// the limit fails before dispatch.
export const RUNTIME_QUEUE_LIMIT = 4;

// No app operation: reaching this code proves that the provider ran its banner.
const BOOTSTRAP =
  'if (typeof cua !== "object" || typeof cua.getApp !== "function" || typeof nodeRepl.rpc !== "function") throw new Error("Required computer facade or trusted-service bridge unavailable");';
// The browser profile also needs the browser facade. Its check opens no tab.
const BROWSER_BOOTSTRAP =
  BOOTSTRAP +
  ' if (typeof cua.getBrowser !== "function" || typeof cua.getTab !== "function" || typeof cua.createBrowserTab !== "function") throw new Error("Required browser facade unavailable");';
const turnKey = (turnId: string, agentId?: string) =>
  JSON.stringify([agentId ?? null, turnId]);
export class RuntimeSupervisor implements ConnectionOwner {
  private rpc: RpcStream;
  private options: SupervisorOptions;
  private state: RuntimeState = "discoverable";
  private generation = randomUUID();
  // Each launcher connection has its own native session identity, and the
  // runtime's requests must echo it. The launcher never sends a persistence
  // scope, so the native service keeps no grant under this identity; the
  // launcher's session grants own all reuse. A reset and a conversation
  // transition keep the identity and the session grants: neither ends an
  // approval.
  private grantSession: string;
  // The turns that ran a call on this runtime and have not received their
  // turn end. A turn end for any other turn has nothing to clean here.
  private turns = new Set<string>();
  private approvalTimers = new Map<string, ReturnType<typeof setTimeout>>();
  // What each pending request may offer, fixed when the request arrived.
  private availability = new Map<
    string,
    { approval: NativeApproval; available: Availability }
  >();
  // Calls whose client gave up while they waited for app access. No grant
  // answers their later requests.
  private abandoned = new Set<string>();
  private reused = 0;
  // Called after a session grant answered a request without a dialog.
  onGrantReused: (() => void) | undefined;
  // Called when a pending approval closes: answered, expired, cancelled by the
  // runtime, or ended with its execution. The client-facing server withdraws
  // its prompt for the request, if one is still open.
  onPendingClosed: ((operationId: string) => void) | undefined;
  private tools: Tool[] = [];
  private active: Execution | undefined;
  private requests = new Map<string, PendingRequest>();
  private tail: Promise<unknown> = Promise.resolve();
  private usedCalls = new Set<string>();
  // Calls that this owner accepted and that have not settled.
  private queued = 0;
  // Ends every ownership wait when the owner fails or closes.
  private stopping = new AbortController();
  private failure: Error | undefined;
  private starting: Promise<void> | undefined;
  private child: ChildProcessWithoutNullStreams | undefined;
  private childExit: Promise<void> | undefined;
  private init: Record<string, unknown> | undefined;
  private launchDiagnostics: LaunchSpec["diagnostics"] | undefined;
  // The provider's first-use output: the computer API and the Computer Use
  // confirmation policy. The tool description has neither, so the next result
  // that the model receives carries it.
  private banner: ToolResult["content"] = [];
  // Called once when the owner fails, so the client-facing server can stop.
  // A deliberate close() does not call it.
  onFailed: ((error: Error) => void) | undefined;

  constructor(rpc: RpcStream, options: SupervisorOptions) {
    if (!nonempty(options.sessionId))
      throw new ConnectionError(
        "state",
        "A real caller session identity is required",
      );
    if (
      options.deadlineMs !== undefined &&
      (!Number.isSafeInteger(options.deadlineMs) ||
        options.deadlineMs < 1 ||
        options.deadlineMs > 2147483647)
    )
      throw new ConnectionError("configuration", "Invalid transport deadline");
    if (
      options.approvalTimeoutMs !== undefined &&
      (!Number.isSafeInteger(options.approvalTimeoutMs) ||
        options.approvalTimeoutMs < 1 ||
        options.approvalTimeoutMs > 2147483647)
    )
      throw new ConnectionError("configuration", "Invalid approval timeout");
    this.rpc = rpc;
    this.options = Object.freeze({ ...options });
    this.grantSession =
      options.connection ?? `claude-cua-connection-${randomUUID()}`;
    rpc.onRequest = (request) => this.serverRequest(request);
    rpc.onNotification = (notification) => {
      if (
        notification.method === "notifications/cancelled" &&
        object(notification.params)
      ) {
        for (const pending of this.requests.values()) {
          if (pending.request.id === notification.params.requestId) {
            this.answer(pending, { action: "cancel" });
            break;
          }
        }
      }
      if (notification.method === "notifications/tools/list_changed")
        this.fail(
          new ConnectionError(
            "protocol",
            "Tool catalog changed; reconnect and validate before further dispatch",
          ),
        );
    };
    rpc.onFailure = (error) => this.fail(error);
  }
  static launch(
    spec: LaunchSpec,
    options: SupervisorOptions,
  ): RuntimeSupervisor {
    if (
      !nonempty(options.sessionId) ||
      (options.deadlineMs !== undefined &&
        (!Number.isSafeInteger(options.deadlineMs) ||
          options.deadlineMs < 1 ||
          options.deadlineMs > 2147483647)) ||
      (options.approvalTimeoutMs !== undefined &&
        (!Number.isSafeInteger(options.approvalTimeoutMs) ||
          options.approvalTimeoutMs < 1 ||
          options.approvalTimeoutMs > 2147483647))
    )
      throw new ConnectionError(
        "configuration",
        "Invalid session identity or transport deadline",
      );
    const connection =
      options.connection ?? `claude-cua-connection-${randomUUID()}`;
    // The native guard in the runtime's trusted worker reads the lease file
    // and compares its holder with this connection.
    const child = spawn(spec.command, [...spec.args], {
      env: {
        ...spec.env,
        ...(options.ownership
          ? {
              [OWNERSHIP_ENV]: options.ownership.path,
              [CONNECTION_ENV]: connection,
            }
          : {}),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const supervisor = new RuntimeSupervisor(
      new RpcStream(child.stdout, child.stdin),
      { ...options, connection },
    );
    supervisor.child = child;
    // The installed launcher starts its executor with inherited stdio, so the
    // executor can outlive the launcher process. The output pipe closes only
    // when every process that holds it has exited.
    const closed = new Promise<void>((resolve) =>
      child.stdout.once("close", () => resolve()),
    );
    supervisor.childExit = new Promise((resolve) => {
      child.once("exit", () => void closed.then(resolve));
      child.once("error", () => {
        if (child.pid === undefined) resolve();
      });
    });
    supervisor.launchDiagnostics = spec.diagnostics;
    // Drain stderr separately. Diagnostics never retain arbitrary cell output.
    child.stderr.resume();
    child.on("error", (error) =>
      supervisor.fail(
        new ConnectionError(
          "transport",
          `Runtime launch failed: ${error.message}`,
        ),
      ),
    );
    child.on("exit", (code, signal) =>
      supervisor.fail(
        new ConnectionError(
          "transport",
          `Runtime exited (${code ?? signal}); external effect unknown`,
        ),
      ),
    );
    return supervisor;
  }
  health() {
    return structuredClone({
      state: this.state,
      runtimeGeneration: this.generation,
      server: this.init?.serverInfo,
      protocolVersion: this.init?.protocolVersion,
      launch: this.launchDiagnostics,
      failure: this.failure?.message,
      nativePermission: "unverified",
      taskSuccess: "unverified",
      recovery:
        "No rollback guarantee. Reset clears bindings, not apps or permissions.",
    });
  }
  catalog(): Tool[] {
    this.available();
    return structuredClone(this.tools);
  }
  serverInfo() {
    return structuredClone(this.init);
  }
  start(): Promise<void> {
    if (this.starting) return this.starting;
    this.starting = this.initialize();
    return this.starting;
  }
  private async initialize() {
    try {
      this.available();
      const value = await this.rpc.request(
        "initialize",
        {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { elicitation: { form: {} } },
          clientInfo: { name: "claude-cua-owner", version: "0.1.0" },
        },
        this.options.deadlineMs,
      );
      if (
        !object(value) ||
        value.protocolVersion !== PROTOCOL_VERSION ||
        !object(value.capabilities) ||
        !object(value.capabilities.tools) ||
        !object(value.serverInfo) ||
        !nonempty(value.serverInfo.name) ||
        !nonempty(value.serverInfo.version)
      )
        throw new ConnectionError(
          "protocol",
          "Unsupported protocol, missing tools capability, or invalid server identity",
        );
      this.available();
      this.init = value;
      this.rpc.notify("notifications/initialized");
      this.tools = validateTools(
        await this.rpc.request("tools/list", {}, this.options.deadlineMs),
      );
      this.available();
      this.state = "initialized";
      await this.bootstrap();
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }
  private async bootstrap() {
    const result = validateResult(
      await this.rpc.request(
        "tools/call",
        {
          name: "js",
          arguments: {
            code: this.launchDiagnostics?.surfaces.includes("browser")
              ? BROWSER_BOOTSTRAP
              : BOOTSTRAP,
          },
        },
        this.options.deadlineMs,
      ),
    );
    if (result.isError)
      throw new ConnectionError(
        "state",
        "Runtime bootstrap failed; discovery does not establish readiness",
        result,
      );
    this.available();
    this.banner = result.content;
    this.state = "ready";
  }
  private deadlineFor(tool: string, args: Record<string, Json>): number {
    const base = this.options.deadlineMs ?? DEFAULT_DEADLINE_MS;
    const requested =
      tool === "js" && typeof args.timeout_ms === "number"
        ? args.timeout_ms + JS_DEADLINE_MARGIN_MS
        : 0;
    return Math.min(MAX_DEADLINE_MS, Math.max(base, requested));
  }
  private available() {
    if (this.state === "failed" || this.state === "stopped")
      throw this.failure ?? new ConnectionError("state", "Runtime stopped");
  }
  private validateCaller(caller: Caller) {
    if (
      !object(caller) ||
      Object.keys(caller).some(
        (key) =>
          ![
            "sessionId",
            "agentId",
            "turnId",
            "toolUseId",
            "runtimeGeneration",
          ].includes(key),
      ) ||
      ![
        caller.sessionId,
        caller.turnId,
        caller.toolUseId,
        caller.runtimeGeneration,
      ].every(nonempty) ||
      (caller.agentId !== undefined && !nonempty(caller.agentId)) ||
      caller.sessionId !== this.options.sessionId ||
      caller.runtimeGeneration !== this.generation
    )
      throw new ConnectionError(
        "state",
        "Unknown caller identity or stale runtime generation",
      );
  }
  async call(
    caller: Caller,
    tool: string,
    args: Record<string, Json>,
  ): Promise<ToolResult> {
    this.available();
    if (this.state !== "ready")
      throw new ConnectionError("state", "Runtime is not ready");
    this.validateCaller(caller);
    validateArguments(tool, args);
    if (tool === "turn_ended")
      throw new ConnectionError(
        "state",
        "turn_ended is reserved for host lifecycle delivery",
      );
    const key = caller.toolUseId;
    if (this.usedCalls.has(key))
      throw new ConnectionError(
        "state",
        "Caller tool-use identity was already submitted; no automatic replay",
      );
    this.usedCalls.add(key);
    if (this.queued > (this.options.queueLimit ?? RUNTIME_QUEUE_LIMIT))
      throw new ConnectionError(
        "state",
        `${this.queued} calls of this caller already run or wait; this call did not run`,
      );
    this.queued++;
    const savedCaller = Object.freeze({ ...caller });
    const savedArgs = structuredClone(args);
    const work = this.tail.then(async () => {
      this.available();
      this.validateCaller(savedCaller);
      if (this.state === "initialized") await this.bootstrap();
      if (this.state !== "ready")
        throw new ConnectionError("state", "Runtime is not ready");
      this.options.beforeDispatch?.();
      const lease = await this.acquire(savedCaller);
      try {
        // The wait can outlast a transition, a failure, or the gate.
        this.available();
        this.validateCaller(savedCaller);
        this.options.beforeDispatch?.();
        return await this.execute(savedCaller, tool, savedArgs);
      } finally {
        this.release(lease);
      }
    });
    const settled = work.finally(() => this.queued--);
    this.tail = settled.catch(() => {});
    return settled;
  }
  // Waits for the lease of the controlled resource. A refusal fails only this
  // call: the call did not reach the runtime.
  private async acquire(
    caller: Pick<Caller, "sessionId" | "agentId" | "toolUseId">,
  ): Promise<Lease | undefined> {
    const ownership = this.options.ownership;
    if (!ownership) return undefined;
    try {
      const runtimePid = this.child?.pid;
      return await ownership.acquire(
        {
          connection: this.grantSession,
          ...(runtimePid === undefined
            ? {}
            : { runtimePid, executorPids: descendants(runtimePid) }),
          sessionId: caller.sessionId,
          ...(caller.agentId === undefined ? {} : { agentId: caller.agentId }),
          toolUseId: caller.toolUseId,
        },
        this.stopping.signal,
      );
    } catch (error) {
      if (error instanceof OwnershipError)
        throw new ConnectionError("policy", error.message);
      throw error;
    }
  }
  // A runtime in a known state releases the lease at once. A failed or
  // stopped runtime can still act until its processes exit, so its lease
  // stays until then.
  private release(lease: Lease | undefined) {
    if (!lease) return;
    if (this.state === "failed" || this.state === "stopped")
      lease.releaseAfter(this.exited());
    else lease.release();
  }
  private async execute(
    savedCaller: Caller,
    tool: string,
    savedArgs: Record<string, Json>,
  ): Promise<ToolResult> {
    const execution: Execution = {
      id: randomUUID(),
      caller: savedCaller,
      token: randomUUID(),
      deadline: { pause() {}, resume() {} },
    };
    this.active = execution;
    this.turns.add(turnKey(savedCaller.turnId, savedCaller.agentId));
    try {
      let result = validateResult(
        await this.rpc.request(
          "tools/call",
          {
            name: tool,
            arguments: savedArgs,
            _meta: {
              progressToken: execution.token,
              "x-codex-turn-metadata": {
                session_id: this.grantSession,
                turn_id: savedCaller.turnId,
                call_id: savedCaller.toolUseId,
                ...(savedCaller.agentId
                  ? { agent_id: savedCaller.agentId }
                  : {}),
              },
            },
          },
          this.deadlineFor(tool, savedArgs),
          () => this.expire(execution),
          execution.deadline,
        ),
      );
      this.available();
      if (this.banner.length > 0) {
        result = { ...result, content: [...this.banner, ...result.content] };
        this.banner = [];
      }
      if (tool === "js_reset") {
        if (result.isError)
          this.fail(
            new ConnectionError(
              "state",
              "Reset failed; binding state is unknown",
            ),
          );
        else {
          this.generation = randomUUID();
          this.state = "initialized";
        }
      }
      return result;
    } catch (error) {
      // A JSON-RPC error has no trustworthy kernel recovery contract. A content
      // failure arrived in a valid, correlated response, so only the call fails.
      if (!(error instanceof ConnectionError && error.kind === "content"))
        this.fail(error instanceof Error ? error : new Error(String(error)));
      throw error;
    } finally {
      this.expire(execution);
      this.abandoned.delete(savedCaller.toolUseId);
    }
  }
  // A successful reset requires a new caller generation and bootstrap before js.
  async ready(): Promise<void> {
    const work = this.tail.then(async () => {
      this.available();
      if (this.state === "initialized") await this.bootstrap();
      if (this.state !== "ready")
        throw new ConnectionError("state", "Runtime has not initialized");
    });
    this.tail = work.catch(() => {});
    try {
      await work;
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }
  private expire(execution: Execution) {
    if (this.active !== execution) return;
    this.active = undefined;
    for (const [id, pending] of this.requests) {
      this.requests.delete(id);
      this.availability.delete(id);
      clearTimeout(this.approvalTimers.get(id));
      this.approvalTimers.delete(id);
      this.pendingClosed(id);
      try {
        this.rpc.error(
          pending.request.id,
          -32000,
          "Execution is no longer active",
        );
      } catch {
        /* Transport may already be closed. */
      }
    }
  }
  private serverRequest(request: Request) {
    if (request.method === "ping") {
      this.rpc.result(request.id, {});
      return;
    }
    if (request.method !== "elicitation/create") {
      this.rpc.error(
        request.id,
        -32601,
        `Unsupported required host request: ${request.method}`,
      );
      return;
    }
    const params = request.params;
    if (
      !object(params) ||
      params.mode !== "form" ||
      !nonempty(params.message) ||
      !object(params.requestedSchema) ||
      params.requestedSchema.type !== "object" ||
      !object(params._meta)
    ) {
      this.rpc.error(request.id, -32602, "Unsupported elicitation payload");
      return;
    }
    const execution = this.active;
    // Never infer ownership from whichever call happens to be active now.
    const context = params._meta["x-codex-turn-metadata"];
    if (
      !execution ||
      !object(context) ||
      context.session_id !== this.grantSession ||
      context.turn_id !== execution.caller.turnId ||
      context.call_id !== execution.caller.toolUseId ||
      context.agent_id !== execution.caller.agentId ||
      (params._meta.tool_call_id !== undefined &&
        params._meta.tool_call_id !== execution.caller.toolUseId)
    ) {
      this.rpc.error(
        request.id,
        -32000,
        "Obsolete or uncorrelated host request",
      );
      return;
    }
    // A call that a transition retired can catch its cancellation and ask
    // again. No decision could resolve that request, so it is cancelled now.
    if (execution.caller.runtimeGeneration !== this.generation) {
      this.rpc.result(request.id, { action: "cancel" });
      return;
    }
    let approval: NativeApproval;
    try {
      approval = nativeApproval(request as ServerRequest);
    } catch (error) {
      this.rpc.error(
        request.id,
        -32602,
        error instanceof Error ? error.message : "Unsupported approval",
      );
      return;
    }
    // The Codex app holds lasting browser permissions, and the browser
    // service keeps each browser answer itself. So the launcher keeps no
    // browser grant and passes the answer through (decision 0002).
    const browser = approval.kind !== "app";
    // A session grant answers with a plain accept. The native wrapper still
    // receives that accept and applies its own checks to the operation.
    if (!browser && this.reusable(execution.caller, approval)) {
      this.reused++;
      this.rpc.result(request.id, { action: "accept", content: {} });
      try {
        this.onGrantReused?.();
      } catch {
        /* A failing listener cannot change the decision already sent. */
      }
      return;
    }
    const available: Availability = {
      scopes: browser || this.options.grants ? approval.scopes : ["once"],
    };
    const pending = Object.freeze({
      operationId: randomUUID(),
      caller: execution.caller,
      request: structuredClone(request) as ServerRequest,
    });
    this.requests.set(pending.operationId, pending);
    this.availability.set(pending.operationId, { approval, available });
    const timer = setTimeout(() => {
      if (this.requests.has(pending.operationId)) {
        try {
          this.answer(pending, { action: "cancel" });
        } catch (error) {
          this.fail(error instanceof Error ? error : new Error(String(error)));
        }
      }
    }, this.approvalTimeoutMs());
    timer.unref();
    this.approvalTimers.set(pending.operationId, timer);
    // The runtime now waits on the user, not on its own work.
    execution.deadline.pause();
    if (!this.options.onPending) {
      this.answer(pending, { action: "cancel" });
      return;
    }
    try {
      this.options.onPending(structuredClone(pending));
    } catch {
      if (this.requests.has(pending.operationId))
        this.answer(pending, { action: "cancel" });
    }
  }
  private pendingClosed(operationId: string) {
    try {
      this.onPendingClosed?.(operationId);
    } catch {
      /* A failing listener cannot change the decision already sent. */
    }
  }
  // A grant never answers for a call that its client abandoned, or while the
  // launcher gate refuses dispatch. A failed check asks the user instead.
  private reusable(caller: Caller, approval: NativeApproval): boolean {
    if (!this.options.grants || this.abandoned.has(caller.toolUseId))
      return false;
    try {
      this.options.beforeDispatch?.();
      return this.options.grants.reuse(approval);
    } catch {
      return false;
    }
  }
  // Marks a call that its client gave up while it waited for app access.
  abandon(toolUseId: string) {
    this.abandoned.add(toolUseId);
  }
  // The dialog facts for a pending request, with the scopes that it may offer.
  offer(pending: PendingRequest): ApprovalOffer {
    return approvalOffer(
      pending,
      this.availability.get(pending.operationId)?.available ?? {
        scopes: ["once"],
      },
    );
  }
  grantStatus(): {
    reusedGrants: number;
    sessionGrants: SessionGrant[];
  } {
    return {
      reusedGrants: this.reused,
      sessionGrants: this.options.grants?.list() ?? [],
    };
  }
  approvalTimeoutMs(): number {
    return this.options.approvalTimeoutMs ?? 300000;
  }
  pending(): readonly PendingRequest[] {
    return structuredClone([...this.requests.values()]);
  }
  answer(pending: PendingRequest, decision: Decision) {
    const current = this.requests.get(pending.operationId);
    if (
      !current ||
      JSON.stringify(current) !== JSON.stringify(pending) ||
      !this.active ||
      // A retired generation can still cancel its own pending request, so a
      // transition can retire the generation before it cancels. A cancel
      // never grants access.
      (current.caller.runtimeGeneration !== this.generation &&
        decision.action !== "cancel")
    )
      throw new ConnectionError(
        "state",
        "Obsolete or mismatched pending request",
      );
    const offered = this.availability.get(pending.operationId);
    let resolved: Decision;
    let invalid: unknown;
    try {
      resolved = nativeDecision(
        current.request,
        decision,
        offered?.available.scopes ?? ["once"],
      );
      // A session grant is recorded before the runtime receives the accept.
      // A browser answer passes through: the browser service keeps it, and
      // the launcher keeps no browser grant.
      if (
        resolved.action === "accept" &&
        decision.content?.scope === "session" &&
        offered?.approval.kind === "app"
      )
        this.options.grants!.record(offered.approval);
    } catch (error) {
      resolved = { action: "cancel" };
      invalid = error;
    }
    clearTimeout(this.approvalTimers.get(pending.operationId));
    this.approvalTimers.delete(pending.operationId);
    this.requests.delete(pending.operationId);
    this.availability.delete(pending.operationId);
    this.pendingClosed(pending.operationId);
    // Sending the decision can complete the call before result() returns.
    const execution = this.active;
    this.rpc.result(current.request.id, resolved);
    if (this.requests.size === 0 && this.active === execution)
      execution.deadline.resume();
    if (invalid) throw invalid;
  }
  // Delivers a host lifecycle event to this runtime and resolves to a report of
  // the outcome. A turn end reaches the runtime only for a turn that ran a call
  // here, once. A conversation transition cancels pending approvals and
  // discards bindings, but keeps session grants. No outcome claims that cleanup
  // succeeded: the runtime's turn-end handlers suppress their own failures.
  lifecycle(event: LifecycleEvent): Promise<string> {
    if (event.type === "session.end") return this.transition(event.reason);
    const key = turnKey(event.turnId, event.agentId);
    if (!this.turns.delete(key))
      return Promise.resolve(
        `Turn end skipped: no call of this turn ran on this runtime, or it already received its turn end`,
      );
    const args = {
      hook_event_name:
        event.agentId !== undefined
          ? "SubagentStop"
          : event.isAborted
            ? "Interrupt"
            : "Stop",
      // The session that the calls of this runtime carried. The browser
      // service keys the tabs that a call created or claimed by that session,
      // also for a subagent: its calls carry no Codex thread identity, which
      // the installed plugin's subagent mapping would need.
      session_id: this.grantSession,
      turn_id: event.turnId,
    };
    const work = this.tail.then(async () => {
      if (this.state === "failed" || this.state === "stopped")
        return "Turn end skipped: the runtime stopped";
      validateArguments("turn_ended", args);
      // Turn-end handlers can make native requests, so they wait for the
      // lease too. When another runtime keeps it, the turn end still arrives,
      // and the native guard refuses the native requests of its handlers.
      let lease: Lease | undefined;
      let unowned = "";
      try {
        lease = await this.acquire({
          sessionId: this.options.sessionId,
          ...(event.agentId === undefined ? {} : { agentId: event.agentId }),
          toolUseId: `turn-end:${event.turnId}`,
        });
      } catch (error) {
        if (this.stopping.signal.aborted)
          return "Turn end skipped: the runtime stopped";
        unowned = ` without the computer lease (${error instanceof Error ? error.message : String(error)}), so native cleanup was refused`;
      }
      try {
        const result = validateResult(
          await this.rpc.request(
            "tools/call",
            { name: "turn_ended", arguments: args },
            this.options.cleanupDeadlineMs ?? CLEANUP_DEADLINE_MS,
          ),
        );
        return result.isError
          ? `Turn end ${args.hook_event_name} returned an error${unowned}; cleanup state unknown`
          : `Turn end ${args.hook_event_name} delivered${unowned}; cleanup success unverified`;
      } catch (error) {
        // The runtime fails before the release, so a runtime in an unknown
        // state keeps the lease until its processes exit.
        if (!(error instanceof ConnectionError && error.kind === "content"))
          this.fail(error instanceof Error ? error : new Error(String(error)));
        throw error;
      } finally {
        this.release(lease);
      }
    });
    this.tail = work.catch(() => {});
    return work.catch((error: unknown) => {
      if (!(error instanceof ConnectionError && error.kind === "content"))
        this.fail(error instanceof Error ? error : new Error(String(error)));
      return `Turn end ${args.hook_event_name} failed: ${error instanceof Error ? error.message : String(error)}`;
    });
  }
  // A clear or resume starts another conversation in the same process. No call
  // or approval of the old conversation may act in the new one.
  private transition(reason: string): Promise<string> {
    // Calls queued before the transition carry the old generation and fail its
    // caller check, so none of them runs in the new conversation. The
    // generation changes first: a script can answer a cancel at once with a
    // new approval request, which must already meet the retired generation.
    this.generation = randomUUID();
    for (const pending of this.pending())
      try {
        this.answer(pending, { action: "cancel" });
      } catch {
        /* The approval already closed. */
      }
    this.turns.clear();
    // The running call belongs to the old conversation. The reset waits
    // behind it, so a call that does not end in time fails the runtime.
    const retired = this.active;
    if (retired) {
      const timer = setTimeout(() => {
        if (this.active === retired)
          this.fail(
            new ConnectionError(
              "state",
              "A call of the previous conversation did not end after the transition; external effect unknown",
            ),
          );
      }, this.options.transitionGraceMs ?? TRANSITION_GRACE_MS);
      timer.unref();
    }
    const work = this.tail.then(async () => {
      this.available();
      const result = validateResult(
        await this.rpc.request(
          "tools/call",
          { name: "js_reset", arguments: {} },
          this.options.deadlineMs,
        ),
      );
      if (result.isError)
        throw new ConnectionError(
          "state",
          "Reset failed; binding state is unknown",
          result,
        );
      this.state = "initialized";
      return `Conversation ${reason}: approvals cancelled, bindings reset, session grants kept`;
    });
    this.tail = work.catch(() => {});
    return work.catch((error: unknown) => {
      this.fail(error instanceof Error ? error : new Error(String(error)));
      return `Conversation ${reason}: reset failed, so the runtime stopped (${error instanceof Error ? error.message : String(error)})`;
    });
  }
  private fail(error: Error) {
    if (this.state === "stopped" || this.state === "failed") return;
    this.state = "failed";
    this.failure = error;
    this.stopping.abort();
    for (const timer of this.approvalTimers.values()) clearTimeout(timer);
    this.approvalTimers.clear();
    this.requests.clear();
    this.availability.clear();
    this.active = undefined;
    this.rpc.fail(error);
    this.stopChild();
    try {
      this.onFailed?.(error);
    } catch {
      /* A failing listener cannot change the failed state. */
    }
  }
  // The kill timer keeps the process alive, so the launcher cannot exit and
  // release session ownership while the runtime can still act.
  private stopChild() {
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
    }, STOP_GRACE_MS);
    child.once("exit", () => clearTimeout(timer));
  }
  // Resolves when the runtime process has exited, or at once when this owner
  // has no process.
  exited(): Promise<void> {
    return this.childExit ?? Promise.resolve();
  }
  close() {
    if (this.state === "stopped") return;
    this.state = "stopped";
    this.stopping.abort();
    for (const timer of this.approvalTimers.values()) clearTimeout(timer);
    this.approvalTimers.clear();
    this.requests.clear();
    this.availability.clear();
    this.active = undefined;
    this.rpc.close();
    this.stopChild();
  }
}
