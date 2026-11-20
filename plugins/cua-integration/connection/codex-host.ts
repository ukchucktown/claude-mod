import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import type { Decision, Json, RpcId, ServerRequest } from "../contracts.ts";
import { live } from "../private-files.ts";
import { descendants } from "./ownership.ts";
import {
  ConnectionError,
  nonempty,
  object,
  rpcId,
  RpcError,
  RpcStream,
  type DeadlineControl,
  type Envelope,
  type Request,
} from "./protocol.ts";

// The Codex host is one process of `codex app-server --listen stdio://`
// (decision 0003). It starts the declared runtime server as its own child
// process, so the Computer Use service finds a signed OpenAI process among
// the ancestors of the runtime. This module owns the app-server protocol and
// the host process. The supervisor sees only the `RuntimeHost` interface.

// The methods of the app-server protocol that the launcher uses.
const INITIALIZE = "initialize";
const INITIALIZED = "initialized";
const THREAD_START = "thread/start";
const SERVER_STATUS = "mcpServerStatus/list";
const TOOL_CALL = "mcpServer/tool/call";
const APPROVAL_REQUEST = "mcpServer/elicitation/request";
const STARTUP_STATUS = "mcpServer/startupStatus/updated";
const REQUEST_RESOLVED = "serverRequest/resolved";

// The app-server sends JSON-RPC frames without the version member.
const APP_SERVER_ENVELOPE: Envelope = Object.freeze({
  members: Object.freeze({}),
  admits: (frame: Record<string, unknown>) => !("jsonrpc" in frame),
});
// The name that the launcher gives in the handshake. The host starts its
// user agent with this name and its own version.
export const CLIENT_NAME = "claude_cua_launcher";
// An approval request reaches the launcher only with this policy. With the
// policy `never`, the host refuses each request, and no person sees it.
export const APPROVAL_POLICY = "on-request";
export const SANDBOX = "read-only";
// How long the host waits for the handshake of the runtime server.
export const HOST_STARTUP_TIMEOUT_SEC = 120;
// The host has its own timeout for a tool call. The supervisor owns each
// deadline, and a deadline stops while an approval waits for a person. Thus,
// the timeout of the host is 30 days, which is longer than each deadline of
// the supervisor.
export const HOST_TOOL_TIMEOUT_SEC = 2592000;
// How long the host has for each step of its stop: after its input closes,
// and after the termination signal.
export const STOP_GRACE_MS = 1000;
// How often a stopped host checks whether its processes exited.
const EXIT_POLL_MS = 50;
// The start time of each of the processes that still run, from the process
// table. A process ID that the system gave to another process has another
// start time, so the launcher never signals a process that it did not record.
function startTimes(pids: readonly number[]): Map<number, string> {
  const found = new Map<number, string>();
  if (pids.length === 0) return found;
  let table: string;
  try {
    table = execFileSync(
      "/bin/ps",
      ["-o", "pid=,lstart=", "-p", pids.join(",")],
      { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] },
    );
  } catch (error) {
    // `ps` exits with a failure when no listed process runs.
    table = String((error as { stdout?: unknown }).stdout ?? "");
  }
  for (const line of table.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(.+)$/);
    if (match) found.set(Number(match[1]), match[2]!);
  }
  return found;
}
// The start of each refusal for a host that differs from the reviewed
// protocol.
const CHANGED = "Changed Codex host contract";
const changed = (method: string, difference: string) =>
  new ConnectionError("protocol", `${CHANGED}: ${method}: ${difference}`);

// The runtime server that the host starts, as discovery checked it.
export type HostedServer = Readonly<{
  command: string;
  args: readonly string[];
  env: Readonly<Record<string, string>>;
}>;
export type HostLaunch = Readonly<{
  // The Codex CLI executable.
  codex: string;
  // The version that discovery read from the CLI. The handshake must report
  // the same version.
  codexVersion: string;
  // The name of the runtime server in the configuration of the host.
  name: string;
  server: HostedServer;
  // The complete environment of the host process, without its Codex home.
  environment: Readonly<Record<string, string>>;
}>;
// What a started host reports: the tool catalog of the runtime server, for
// the schema check, and the identities of the two processes.
export type HostSession = Readonly<{
  catalog: { tools: unknown[] };
  server: { name: string; version: string };
  userAgent: string;
}>;
export type CallDeadline = {
  // The deadline of the call. Absent for the default deadline.
  ms?: number | undefined;
  // Called when the response arrives, before the host reads another frame.
  settled?: () => void;
  // Receives the methods that stop and continue the deadline clock.
  control?: DeadlineControl;
};
// The operations that the supervisor uses. One host serves one caller
// runtime: it has one thread, and the supervisor runs one call at a time.
export interface RuntimeHost {
  // The process of the host, when this launcher started one.
  readonly pid: number | undefined;
  // Receives each approval request of the runtime in the MCP form
  // `elicitation/create`. The supervisor answers or refuses each request one
  // time, with the `id` of the request.
  onApproval: (request: ServerRequest) => void;
  // Called when the host reports that a request needs no answer any more.
  // The host also sends this report after each answer of the launcher.
  onWithdrawn: (id: RpcId) => void;
  // Called once when the connection to the host fails.
  onFailure: (error: Error) => void;
  // Makes the handshake, starts the thread, and reads the tool catalog.
  start(deadlineMs?: number): Promise<HostSession>;
  // Calls one tool of the runtime one time. The protocol has no method that
  // cancels a call, so only `stop` ends a call that runs.
  call(
    tool: string,
    args: Record<string, Json>,
    meta?: Record<string, Json>,
    deadline?: CallDeadline,
  ): Promise<unknown>;
  answer(id: RpcId, decision: Decision): void;
  // Refuses a request that no decision of a person can answer. The runtime
  // receives `cancel`.
  refuse(id: RpcId): void;
  // The processes that the host started, at any depth, as the process table
  // shows them now.
  processes(): number[];
  // Fails each waiting request with the reason and stops the host process.
  stop(reason?: Error): void;
  // Resolves when the host and each process that it started have exited.
  exited(): Promise<void>;
}

// A TOML basic string. JSON escapes agree with TOML, except for the delete
// character, which TOML does not permit in a string.
const toml = (value: string) =>
  JSON.stringify(value).replaceAll("\x7f", "\\u007F");
// The command line of the host: the stdio transport and the configuration of
// one thread runtime. The host reads no other server, app, or plugin.
export function hostArguments(name: string, server: HostedServer): string[] {
  if (!/^[A-Za-z0-9_-]+$/.test(name))
    throw new ConnectionError("configuration", "Invalid runtime server name");
  const key = `mcp_servers.${name}`;
  const settings = [
    `${key}.command=${toml(server.command)}`,
    `${key}.args=[${server.args.map(toml).join(",")}]`,
    `${key}.startup_timeout_sec=${HOST_STARTUP_TIMEOUT_SEC}`,
    `${key}.tool_timeout_sec=${HOST_TOOL_TIMEOUT_SEC}`,
    ...Object.entries(server.env).map(([variable, value]) => {
      if (!/^[A-Za-z0-9_]+$/.test(variable))
        throw new ConnectionError(
          "configuration",
          `Invalid runtime environment name: ${variable}`,
        );
      return `${key}.env.${variable}=${toml(value)}`;
    }),
    "features.apps=false",
    "features.plugins=false",
    "analytics.enabled=false",
    'cli_auth_credentials_store="ephemeral"',
  ];
  return [
    "app-server",
    "--listen",
    "stdio://",
    ...settings.flatMap((setting) => ["-c", setting]),
  ];
}

// The private directory of one host has the process ID of its launcher in
// its name. A launcher that the system killed cannot remove its directory,
// so each launch removes the directories of launchers that no longer run.
const HOME_PREFIX = "claude-cua-codex-";
function removeStaleHomes() {
  try {
    for (const name of readdirSync(tmpdir())) {
      const launcher = name.match(/^claude-cua-codex-(\d+)-/)?.[1];
      if (launcher === undefined || live(Number(launcher))) continue;
      const path = join(tmpdir(), name);
      const entry = lstatSync(path);
      if (entry.isDirectory() && entry.uid === process.getuid?.())
        rmSync(path, { recursive: true, force: true });
    }
  } catch {
    /* A directory that stays holds no state that a later launch reads. */
  }
}

export class CodexHost implements RuntimeHost {
  private rpc: RpcStream;
  private name: string;
  private home: string;
  private cwd: string;
  private codexVersion: string | undefined;
  private thread: string | undefined;
  private child: ChildProcess | undefined;
  private childExit: Promise<void> | undefined;
  // Each process that the host started and that the process table showed,
  // with its start time.
  private tree = new Map<number, string>();
  private stopped = false;
  onApproval: (request: ServerRequest) => void = () => {};
  onWithdrawn: (id: RpcId) => void = () => {};
  onFailure: (error: Error) => void = () => {};

  // A host on a stream pair. `home` is the Codex home that the host must
  // report, and `cwd` is the working directory of its thread.
  constructor(
    input: Readable,
    output: Writable,
    options: { name: string; home: string; cwd: string; codexVersion?: string },
  ) {
    this.name = options.name;
    this.home = options.home;
    this.cwd = options.cwd;
    this.codexVersion = options.codexVersion;
    this.rpc = new RpcStream(input, output, undefined, APP_SERVER_ENVELOPE);
    this.rpc.onRequest = (request) => this.serverRequest(request);
    this.rpc.onNotification = (notification) => {
      const params = notification.params;
      if (
        notification.method === REQUEST_RESOLVED &&
        object(params) &&
        params.threadId === this.thread &&
        rpcId(params.requestId)
      )
        this.onWithdrawn(params.requestId);
      // The runtime server of this thread did not start, or it stopped.
      if (
        notification.method === STARTUP_STATUS &&
        object(params) &&
        params.name === this.name &&
        (params.threadId === undefined ||
          params.threadId === null ||
          params.threadId === this.thread) &&
        (params.status === "failed" || params.status === "cancelled")
      )
        this.rpc.fail(
          new ConnectionError(
            "transport",
            `The Codex host did not start the runtime (${params.status}); external effect unknown`,
            typeof params.error === "string" ? params.error : undefined,
          ),
        );
    };
    this.rpc.onFailure = (error) => this.onFailure(error);
  }

  // Starts the host process with a private Codex home, so the host reads no
  // login and no setting of the user, and writes no state of the user
  // (decision 0002). The home and the working directory are in one temporary
  // directory with mode 0700, which the launcher removes after the stop.
  static launch(launch: HostLaunch): CodexHost {
    removeStaleHomes();
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), `${HOME_PREFIX}${process.pid}-`)),
    );
    const home = join(root, "home");
    const cwd = join(root, "work");
    let child: ChildProcess;
    try {
      mkdirSync(home, { mode: 0o700 });
      mkdirSync(cwd, { mode: 0o700 });
      child = spawn(launch.codex, hostArguments(launch.name, launch.server), {
        env: { ...launch.environment, CODEX_HOME: home },
        cwd,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      rmSync(root, { recursive: true, force: true });
      throw error;
    }
    const host = new CodexHost(child.stdout!, child.stdin!, {
      name: launch.name,
      home,
      cwd,
      codexVersion: launch.codexVersion,
    });
    host.child = child;
    // The log of the host can hold cell output, so the launcher keeps none.
    child.stderr!.resume();
    const exit = new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      child.once("error", () => {
        if (child.pid === undefined) resolve();
      });
    });
    // The processes of the runtime exit a short time after the host. The
    // host is gone only when each of them is gone.
    host.childExit = exit
      .then(() => host.reap())
      .then(() => host.treeExit())
      .then(() => rmSync(root, { recursive: true, force: true }));
    child.on("error", (error) =>
      host.rpc.fail(
        new ConnectionError(
          "transport",
          `Codex host launch failed: ${error.message}`,
        ),
      ),
    );
    child.on("exit", (code, signal) =>
      host.rpc.fail(
        new ConnectionError(
          "transport",
          `Codex host exited (${code ?? signal}); external effect unknown`,
        ),
      ),
    );
    return host;
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  // One request of the start. A request that the host refuses, and a frame
  // that is not of the reviewed protocol, name the changed contract.
  private async ask(method: string, params: unknown, deadlineMs?: number) {
    try {
      return await this.rpc.request(method, params, deadlineMs);
    } catch (error) {
      if (error instanceof RpcError)
        throw changed(
          method,
          `the host refused the request (${error.code}: ${error.message})`,
        );
      if (
        error instanceof ConnectionError &&
        error.kind === "protocol" &&
        !error.message.startsWith(CHANGED)
      )
        throw changed(method, error.message);
      throw error;
    }
  }
  async start(deadlineMs?: number): Promise<HostSession> {
    const initialized = await this.ask(
      INITIALIZE,
      {
        clientInfo: {
          name: CLIENT_NAME,
          title: "Claude CUA launcher",
          version: "0.1.0",
        },
        // The launcher uses no experimental method or field (decision 0003).
        capabilities: { experimentalApi: false },
      },
      deadlineMs,
    );
    if (!object(initialized) || !nonempty(initialized.userAgent))
      throw changed(INITIALIZE, "the result names no user agent");
    if (
      this.codexVersion !== undefined &&
      !initialized.userAgent.startsWith(`${CLIENT_NAME}/${this.codexVersion} `)
    )
      throw changed(
        INITIALIZE,
        `the user agent does not name Codex CLI ${this.codexVersion}`,
      );
    if (initialized.codexHome !== this.home)
      throw changed(
        INITIALIZE,
        "the host does not use the Codex home of the launcher",
      );
    this.rpc.notify(INITIALIZED);
    const started = await this.ask(
      THREAD_START,
      {
        cwd: this.cwd,
        ephemeral: true,
        sandbox: SANDBOX,
        approvalPolicy: APPROVAL_POLICY,
      },
      deadlineMs,
    );
    if (
      !object(started) ||
      !object(started.thread) ||
      !nonempty(started.thread.id)
    )
      throw changed(THREAD_START, "the result names no thread");
    if (started.approvalPolicy !== APPROVAL_POLICY)
      throw changed(
        THREAD_START,
        `the approval policy of the thread is not ${APPROVAL_POLICY}`,
      );
    // With another reviewer, the host can answer a request itself.
    if (started.approvalsReviewer !== "user")
      throw changed(
        THREAD_START,
        "the thread does not send approval requests to the user",
      );
    if (!object(started.sandbox) || started.sandbox.type !== "readOnly")
      throw changed(THREAD_START, "the sandbox of the thread is not read-only");
    this.thread = started.thread.id;
    // The host starts the runtime server for the thread, and this request
    // waits for the result of that start.
    const status = await this.ask(
      SERVER_STATUS,
      { threadId: this.thread, serverName: this.name, detail: "full" },
      deadlineMs,
    );
    if (
      !object(status) ||
      !Array.isArray(status.data) ||
      (status.nextCursor !== undefined && status.nextCursor !== null)
    )
      throw changed(SERVER_STATUS, "the result is not one complete list");
    const entries = status.data.filter(
      (item) => object(item) && item.name === this.name,
    ) as Array<Record<string, unknown>>;
    if (entries.length !== 1 || status.data.length !== 1)
      throw changed(
        SERVER_STATUS,
        `the result does not name exactly the server ${this.name}`,
      );
    const entry = entries[0]!;
    if (entry.runtimeStatus !== "connected" || nonempty(entry.toolsError))
      throw new ConnectionError(
        "transport",
        `The Codex host did not start the runtime (${String(entry.runtimeStatus)})`,
        typeof entry.toolsError === "string" ? entry.toolsError : undefined,
      );
    if (
      !object(entry.tools) ||
      Object.entries(entry.tools).some(
        ([name, tool]) => !object(tool) || tool.name !== name,
      )
    )
      throw changed(SERVER_STATUS, "the tools are not a map by tool name");
    if (
      !object(entry.serverInfo) ||
      !nonempty(entry.serverInfo.name) ||
      !nonempty(entry.serverInfo.version)
    )
      throw changed(SERVER_STATUS, "the result names no runtime server");
    // Record the runtime processes now, so a host that fails before the first
    // call still leaves a record of them.
    try {
      this.processes();
    } catch {
      /* The lease reads the process table again before each call. */
    }
    return {
      catalog: { tools: Object.values(entry.tools) },
      server: {
        name: entry.serverInfo.name,
        version: entry.serverInfo.version,
      },
      userAgent: initialized.userAgent,
    };
  }

  call(
    tool: string,
    args: Record<string, Json>,
    meta?: Record<string, Json>,
    deadline: CallDeadline = {},
  ): Promise<unknown> {
    if (this.thread === undefined)
      return Promise.reject(
        new ConnectionError("state", "The Codex host has no thread"),
      );
    return this.rpc.request(
      TOOL_CALL,
      {
        threadId: this.thread,
        server: this.name,
        tool,
        arguments: args,
        ...(meta === undefined ? {} : { _meta: meta }),
      },
      deadline.ms,
      deadline.settled,
      deadline.control,
    );
  }

  // The host sends an approval request of the runtime with the thread and the
  // server name beside the MCP parameters. A request of another thread or
  // server never reaches the supervisor.
  private serverRequest(request: Request) {
    if (request.method !== APPROVAL_REQUEST) {
      this.rpc.error(
        request.id,
        -32601,
        `Unsupported host request: ${request.method}`,
      );
      return;
    }
    const { threadId, serverName, turnId, ...params } = object(request.params)
      ? request.params
      : {};
    if (
      this.thread === undefined ||
      threadId !== this.thread ||
      serverName !== this.name ||
      // The launcher starts no model turn.
      (turnId !== undefined && turnId !== null)
    ) {
      this.refuse(request.id);
      return;
    }
    this.onApproval({
      jsonrpc: "2.0",
      id: request.id,
      method: "elicitation/create",
      params: params as Record<string, Json>,
    });
  }
  answer(id: RpcId, decision: Decision) {
    this.rpc.result(id, decision);
  }
  refuse(id: RpcId) {
    this.rpc.result(id, { action: "cancel" });
  }

  processes(): number[] {
    const pid = this.pid;
    if (pid === undefined) return [];
    const found = descendants(pid);
    const unrecorded = found.filter((process) => !this.tree.has(process));
    for (const [process, started] of startTimes(unrecorded))
      this.tree.set(process, started);
    return found;
  }
  // The recorded processes that still run, each with its recorded start time.
  private survivors(): number[] {
    const running = startTimes([...this.tree.keys()].filter(live));
    return [...running]
      .filter(([process, started]) => this.tree.get(process) === started)
      .map(([process]) => process);
  }
  // The host is gone. Its runtime processes normally exit with it. A process
  // that stays can still act, and no host is left to stop it. Thus, the
  // launcher gives each recorded process the termination signal after one
  // grace period and the kill signal after a second one. The lease stays
  // until each of them is gone.
  private reap() {
    const signal = (name: "SIGTERM" | "SIGKILL") => {
      for (const process of this.survivors())
        try {
          globalThis.process.kill(process, name);
        } catch {
          /* The process exited. */
        }
    };
    if (this.survivors().length === 0) return;
    setTimeout(() => signal("SIGTERM"), STOP_GRACE_MS);
    setTimeout(() => signal("SIGKILL"), 2 * STOP_GRACE_MS);
  }
  // Resolves when no recorded process of the host runs.
  private treeExit(): Promise<void> {
    return new Promise((resolve) => {
      const check = () => {
        if (this.survivors().length > 0) setTimeout(check, EXIT_POLL_MS);
        else resolve();
      };
      check();
    });
  }
  // The host exits when its input closes, and its processes exit with it. A
  // host that stays receives the termination signal and then the kill
  // signal. The timers keep the launcher alive, so the launcher cannot exit
  // and release the session while the runtime can still act.
  stop(reason?: Error) {
    if (reason) this.rpc.fail(reason);
    if (this.stopped) return;
    this.stopped = true;
    const child = this.child;
    const running = () =>
      child !== undefined &&
      child.pid !== undefined &&
      child.exitCode === null &&
      child.signalCode === null;
    if (running())
      try {
        this.processes();
      } catch {
        /* The lease keeps the processes that it recorded. */
      }
    this.rpc.close();
    if (!child || !running()) return;
    const terminate = setTimeout(() => {
      if (running()) child.kill("SIGTERM");
    }, STOP_GRACE_MS);
    const kill = setTimeout(() => {
      if (running()) child.kill("SIGKILL");
    }, 2 * STOP_GRACE_MS);
    child.once("exit", () => {
      clearTimeout(terminate);
      clearTimeout(kill);
    });
  }
  exited(): Promise<void> {
    return this.childExit ?? Promise.resolve();
  }
}
