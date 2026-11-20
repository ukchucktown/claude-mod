import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type {
  ApprovalChoice,
  ApprovalOffer,
} from "../policy/native-approval.ts";
import {
  legacyGrantStore,
  resource,
  type AllowAllStatus,
  type LegacyGrantStore,
  type SessionGrant,
} from "../policy/grants.ts";
import {
  create,
  live,
  locked,
  privateDirectory,
  read,
  take,
  write,
} from "../private-files.ts";
import type { FailureCategory } from "./diagnostics.ts";
import {
  UNVERIFIED,
  type CheckResult,
  type NativePermission,
  type RuntimeVersion,
} from "./native-check.ts";
import { ConnectionError } from "./protocol.ts";
import type { ServiceStop } from "./service.ts";

// One recovery: a runtime of one caller failed, and the launcher stayed
// connected.
export type Recovery = {
  // When the runtime failed.
  at: string;
  // The reason category of the failure: an expired deadline, a lost
  // connection to the Codex host or a host that exited, a response outside
  // the protocol, or a runtime in an unknown state, such as after a failed
  // reset. The names give causes, not an order of severity.
  reason: "timeout" | "transport" | "protocol" | "state";
  caller: "main" | "subagent";
  // When the runtime that replaces the failed one started. That runtime
  // starts at the next call of the caller, so the time is absent until then.
  restartedAt?: string;
};
// The version of the plugin that holds this module, from its manifest. A
// launcher writes it to its status. The command line of launcher control,
// which the Mod runs from its own plugin folder, compares its version with
// the version of the launcher (issue #101): after an update, a session can
// run the hooks module of one version with a launcher of another version.
export const PLUGIN_VERSION: string = JSON.parse(
  readFileSync(
    new URL("../.claude-plugin/plugin.json", import.meta.url),
    "utf8",
  ),
).version;

export type ControlStatus = {
  instanceId: string;
  pid: number;
  // The plugin version of the launcher. A launcher before issue #101 wrote
  // none.
  pluginVersion?: string;
  connected: boolean;
  runtimeReady: boolean;
  runtimeGeneration?: string;
  // The review state of the runtime packages of the main runtime. In the
  // mode `compatible-unreviewed`, no maintainer reviewed the named package
  // versions, and each contract check passed.
  runtimeReview?: {
    mode: "reviewed" | "compatible-unreviewed";
    unreviewedPackages: Record<string, string>;
  };
  active: number;
  pending: number;
  // How many caller runtimes the launcher keeps: the main loop's and one for
  // each subagent that called recently.
  runtimes?: number;
  // The recoveries of this launcher: how many it made, how many of them in a
  // row with no completed call between them, the limit for that row, and the
  // most recent recoveries, oldest first. Absent before the first recovery.
  recovery?: {
    count: number;
    inRow: number;
    limit: number;
    recent: Recovery[];
  };
  lastCall: "none" | "active" | "completed" | "failed";
  error?: string;
  // The diagnostic category of the last failure. The error names the cause.
  failure?: FailureCategory | "";
  // The outcomes of the most recent lifecycle events that the launcher
  // handled, oldest first, each with the time it was handled.
  lifecycle?: Array<{ at: string; outcome: string }>;
  // How many approval requests a session grant answered without a dialog,
  // and the session grants of this launcher. The status reports them. No
  // reader takes a decision from them.
  reusedGrants?: number;
  sessionGrants?: SessionGrant[];
  // The allow-all mode of this launcher (decision record 0007): whether it
  // is on, how many requests it answered with no dialog, and the most recent
  // answers. `request` names the last command that the launcher handled for
  // the mode. The mode lives in the memory of the launcher. This entry is a
  // report, and no reader takes a decision from it.
  // `generation` is the enable generation that the mode holds while it is
  // on. Launcher control compares it with the decision file, so a status
  // from before the launcher wrote the end of the mode never shows the mode
  // as on.
  allowAll?: AllowAllStatus & { request?: string; generation?: string };
  // The most recent answers of the Mod, oldest first, each with who answered
  // its dialog as the engine reported it to the Mod. This is evidence for a
  // record. No reader takes a decision from it.
  dialogAnswers?: DialogAnswer[];
  // The last attempt of this launcher to stop the Computer Use service, with
  // its result and its trigger. Absent before the first attempt. The entry
  // stays in the status of a stopped launcher.
  nativeService?: ServiceStop;
  // The version of the main runtime: the runtime plugin and its packages.
  runtimeVersion?: RuntimeVersion;
  // The native check that runs now, or the last one that finished. The Mod
  // waits for the check that it requested by this identifier.
  nativeCheck?: { id: string; state: "running" | "finished" };
  // The native permission of the current runtime, from the last check of
  // this launcher. Each capability stays unverified until a check proves it.
  nativePermission: NativePermission;
  taskSuccess: "unverified";
};
const defaultRoot = () => join(tmpdir(), `claude-cua-${process.getuid?.()}`);
function paths(session: string, root = defaultRoot()) {
  if (!session.trim()) throw new Error("A session identity is required");
  privateDirectory(root);
  const key = createHash("sha256").update(session).digest("hex");
  return {
    status: join(root, `${key}.status.json`),
    decision: join(root, `${key}.decision.json`),
    approvals: join(root, `${key}.approvals.json`),
    // The launcher generates operation IDs as UUIDs. Any other value could
    // name a path outside this session's files.
    answer(operationId: string) {
      if (!OPERATION_ID.test(operationId))
        throw new Error("Malformed approval operation ID");
      return join(root, `${key}.answer.${operationId}.json`);
    },
    // A tool-use ID comes from the host, so its file name uses a digest.
    call(toolUseId: string) {
      const digest = createHash("sha256").update(toolUseId).digest("hex");
      return join(root, `${key}.call.${digest}.json`);
    },
    lifecycle: join(root, `${key}.lifecycle.`),
    // The request of the Mod for one native check.
    check: join(root, `${key}.check.json`),
    // The request of the Mod to turn the allow-all mode on or off.
    allowAll: join(root, `${key}.allow-all.json`),
    // The request of the Mod for one stop of the Computer Use service.
    serviceStop: join(root, `${key}.service-stop.json`),
    // The next lifecycle sequence number for this session.
    sequence: join(root, `${key}.sequence.json`),
  };
}
// What the Mod reports for a call before the host sends it: the turn and the
// agent that the call belongs to, and the conversation that it runs in.
export type CallRecord = {
  toolUseId: string;
  turnId: string;
  agentId?: string;
  conversation: string;
  // When launcher control wrote the record, in milliseconds since the epoch.
  // A record from before its conversation ended belongs to that activation.
  createdAt: number;
};
// A host lifecycle event that the Mod relays, in the shape of LifecycleEvent
// without the session, which the launcher supplies.
export type LifecycleRequest =
  | {
      type: "turn.complete";
      turnId: string;
      agentId?: string;
      isAborted: boolean;
    }
  | { type: "session.end"; reason: string; conversation: string };
const text = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= 256;
const OPERATION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Who answered the dialog of an approval, as the engine reported it to the
// Mod: `person`, `host`, or `none` where no dialog opened or the engine named
// nobody.
export type DialogApprover = "person" | "host" | "none";
const APPROVERS: readonly DialogApprover[] = ["person", "host", "none"];
export type DialogAnswer = {
  at: string;
  operationId: string;
  choice: ApprovalChoice;
  approver: DialogApprover;
};
const CHOICES: readonly ApprovalChoice[] = [
  "once",
  "session",
  "decline",
  "cancel",
];
function statusAt(path: string): ControlStatus {
  const status = read(path);
  if (
    !status ||
    typeof status.instanceId !== "string" ||
    typeof status.connected !== "boolean" ||
    typeof status.runtimeReady !== "boolean" ||
    !Number.isSafeInteger(status.active) ||
    !Number.isSafeInteger(status.pending) ||
    !["none", "active", "completed", "failed"].includes(status.lastCall)
  )
    throw new Error("Malformed launcher status");
  return status;
}
// The enable generation in a decision file, or undefined when the file does
// not enable this launcher instance or names no generation.
function generationAt(path: string, instanceId: string): string | undefined {
  try {
    const decision = read(path);
    return decision.instanceId === instanceId &&
      decision.enabled === true &&
      typeof decision.generation === "string" &&
      OPERATION_ID.test(decision.generation)
      ? decision.generation
      : undefined;
  } catch {
    return undefined;
  }
}
function enabledAt(path: string, instanceId: string): boolean {
  try {
    const decision = read(path);
    return decision.instanceId === instanceId && decision.enabled === true;
  } catch {
    return false;
  }
}
export class LauncherControl {
  private files: ReturnType<typeof paths>;
  private status: ControlStatus;
  private broken = false;
  private closed = false;
  private offered = new Map<string, ApprovalOffer>();
  constructor(session: string, root?: string) {
    this.files = paths(session, root);
    this.status = {
      instanceId: randomUUID(),
      pid: process.pid,
      pluginVersion: PLUGIN_VERSION,
      connected: true,
      runtimeReady: false,
      active: 0,
      pending: 0,
      lastCall: "none",
      nativePermission: UNVERIFIED,
      taskSuccess: "unverified",
    };
    locked(this.files.status, () => {
      if (existsSync(this.files.status)) {
        const previous = statusAt(this.files.status);
        if (previous.connected && live(previous.pid))
          throw new Error("A launcher already owns this session");
        unlinkSync(this.files.status);
      }
      writeFileSync(this.files.status, JSON.stringify(this.status), {
        mode: 0o600,
        flag: "wx",
      });
    });
  }
  // The launcher is the only gate when the Mod hooks do not load, for example
  // under a managed policy that permits only managed hooks. The host still
  // connects the server then, so the refusal names that cause.
  assertEnabled() {
    if (
      this.closed ||
      this.broken ||
      !enabledAt(this.files.decision, this.status.instanceId)
    )
      throw new ConnectionError(
        "policy",
        "CUA is disabled. Use /cua on in the interactive CLI or in Claude Code Desktop. If /cua does not exist, the CUA Mod hooks did not load, for example under a managed policy that permits only managed hooks.",
      );
  }
  publish(update: Partial<ControlStatus>) {
    if (this.closed) throw new Error("Launcher control is closed");
    try {
      locked(this.files.status, () => {
        if (statusAt(this.files.status).instanceId !== this.status.instanceId)
          throw new Error("Launcher control ownership changed");
        this.status = { ...this.status, ...update };
        write(this.files.status, this.status);
      });
    } catch (error) {
      this.broken = true;
      throw error;
    }
  }
  // Replaces the published list of pending approvals. An answer file for an
  // operation that left the list can no longer resolve anything, so it goes.
  offer(approvals: readonly ApprovalOffer[]) {
    if (this.closed) throw new Error("Launcher control is closed");
    const current = new Map(
      approvals.map((offer) => [offer.operationId, offer]),
    );
    for (const operationId of this.offered.keys())
      if (!current.has(operationId))
        rmSync(this.files.answer(operationId), { force: true });
    this.offered = current;
    write(this.files.approvals, {
      instanceId: this.status.instanceId,
      approvals,
    });
  }
  // Collects the answers that the Mod wrote for offered operations. Each answer
  // file is removed once read, so an answer is returned at most once. An
  // unreadable or unexpected answer becomes cancel, so it cannot approve.
  answers(): Array<{
    operationId: string;
    choice: ApprovalChoice;
    approver: DialogApprover;
  }> {
    const answers: Array<{
      operationId: string;
      choice: ApprovalChoice;
      approver: DialogApprover;
    }> = [];
    for (const [operationId, offer] of this.offered) {
      const path = this.files.answer(operationId);
      if (!existsSync(path)) continue;
      let choice: ApprovalChoice = "cancel";
      let approver: DialogApprover = "none";
      try {
        const answer = read(path);
        if (
          answer?.instanceId === this.status.instanceId &&
          answer.operationId === operationId &&
          offer.choices.includes(answer.choice)
        ) {
          choice = answer.choice;
          if (APPROVERS.includes(answer.approver)) approver = answer.approver;
        }
      } catch {
        /* Cancel below. */
      }
      rmSync(path, { force: true });
      answers.push({ operationId, choice, approver });
    }
    return answers;
  }
  // Takes the record that the Mod wrote for one call. The record is removed
  // once read. A record that another launcher instance wrote, or one with an
  // unexpected shape, reads as absent.
  caller(toolUseId: string): CallRecord | undefined {
    const path = this.files.call(toolUseId);
    if (!existsSync(path)) return undefined;
    let record: any;
    try {
      record = read(path);
    } catch {
      record = undefined;
    }
    rmSync(path, { force: true });
    if (
      record?.instanceId !== this.status.instanceId ||
      record.toolUseId !== toolUseId ||
      !text(record.turnId) ||
      !text(record.conversation) ||
      !Number.isSafeInteger(record.createdAt) ||
      (record.agentId !== undefined && !text(record.agentId))
    )
      return undefined;
    return {
      toolUseId,
      turnId: record.turnId,
      conversation: record.conversation,
      createdAt: record.createdAt,
      ...(record.agentId === undefined ? {} : { agentId: record.agentId }),
    };
  }
  // Takes the lifecycle requests that the Mod wrote, oldest first. Each file is
  // removed once read, so a request is returned at most once. A request that
  // the launcher cannot trust is dropped.
  lifecycle(): LifecycleRequest[] {
    const prefix = basename(this.files.lifecycle);
    const directory = dirname(this.files.lifecycle);
    const requests: Array<{ sequence: number; request: LifecycleRequest }> = [];
    for (const name of readdirSync(directory)) {
      if (!name.startsWith(prefix) || !name.endsWith(".json")) continue;
      const path = join(directory, name);
      let record: any;
      try {
        record = read(path);
      } catch {
        record = undefined;
      }
      rmSync(path, { force: true });
      const request = lifecycleRequest(record, this.status.instanceId);
      if (request) requests.push({ sequence: record.sequence, request });
    }
    return requests
      .sort((a, b) => a.sequence - b.sequence)
      .map(({ request }) => request);
  }
  // Takes the request of the Mod for a native check, and resolves to its
  // identifier. The file is removed once read, so a request starts at most
  // one check. A request that another launcher instance received, or one
  // with an unexpected shape, reads as absent.
  checkRequest(): string | undefined {
    if (!existsSync(this.files.check)) return undefined;
    let record: any;
    try {
      record = read(this.files.check);
    } catch {
      record = undefined;
    }
    rmSync(this.files.check, { force: true });
    return record?.instanceId === this.status.instanceId &&
      typeof record.id === "string" &&
      OPERATION_ID.test(record.id)
      ? record.id
      : undefined;
  }
  // Takes the request of the Mod for a stop of the Computer Use service, and
  // resolves to its identifier. The file is removed once read, so a request
  // starts at most one attempt. A request that another launcher instance
  // received, or one with an unexpected shape, reads as absent.
  serviceStopRequest(): { id: string; trigger: "command" | "off" } | undefined {
    if (!existsSync(this.files.serviceStop)) return undefined;
    let record: any;
    try {
      record = read(this.files.serviceStop);
    } catch {
      record = undefined;
    }
    rmSync(this.files.serviceStop, { force: true });
    // A request with no trigger is a request of `/cua stop-service` from
    // launcher control of an earlier version.
    return record?.instanceId === this.status.instanceId &&
      typeof record.id === "string" &&
      OPERATION_ID.test(record.id)
      ? { id: record.id, trigger: record.trigger === "off" ? "off" : "command" }
      : undefined;
  }
  // Takes the request of the Mod for the allow-all mode. The file is removed
  // once read, so the launcher handles a request at most once. A request
  // that another launcher instance received, or one with an unexpected
  // shape, reads as absent. The file is a message only: the mode lives in
  // the memory of the launcher.
  allowAllRequest(): { id: string; on: boolean } | undefined {
    let record: any;
    try {
      // A later command replaces the file, so the launcher claims the file
      // before it reads it. A command that arrives during the read stays
      // for the next call.
      record = take(this.files.allowAll);
    } catch {
      record = undefined;
    }
    return record?.instanceId === this.status.instanceId &&
      typeof record.id === "string" &&
      OPERATION_ID.test(record.id) &&
      typeof record.on === "boolean"
      ? { id: record.id, on: record.on }
      : undefined;
  }
  // The enable generation of this launcher: the identifier of the `/cua on`
  // that enabled it, or undefined while it is disabled. Each `/cua off`
  // ends a generation, and the next `/cua on` starts another one. A second
  // `/cua on` of an enabled launcher keeps the generation. The allow-all
  // mode holds the generation under which the person turned it on, so the
  // mode ends at `/cua off`, also when `/cua on` follows at once.
  enableGeneration(): string | undefined {
    if (this.closed || this.broken) return undefined;
    return generationAt(this.files.decision, this.status.instanceId);
  }
  close() {
    if (this.closed) return;
    try {
      this.offer([]);
    } catch {
      /* Status still reports the disconnect. */
    }
    try {
      const prefix = basename(this.files.status).replace(".status.json", "");
      for (const name of readdirSync(dirname(this.files.status)))
        if (
          name.startsWith(`${prefix}.call.`) ||
          name.startsWith(`${prefix}.lifecycle.`)
        )
          rmSync(join(dirname(this.files.status), name), { force: true });
    } catch {
      /* Leftover records name this instance and cannot act for another. */
    }
    for (const request of [
      this.files.check,
      this.files.serviceStop,
      this.files.allowAll,
    ])
      try {
        rmSync(request, { force: true });
      } catch {
        /* A leftover request names this instance, and no other reads it. */
      }
    try {
      // The session grants and the result of the native check end with this
      // launcher, so the status of a stopped launcher holds neither.
      const { nativeCheck: _ended, ...status } = this.status;
      this.status = status;
      this.publish({
        connected: false,
        runtimeReady: false,
        active: 0,
        pending: 0,
        sessionGrants: [],
        // The mode ends with this launcher.
        ...(this.status.allowAll
          ? {
              allowAll: (({ since: _since, ...rest }) => ({
                ...rest,
                on: false,
              }))(this.status.allowAll),
            }
          : {}),
        nativePermission: UNVERIFIED,
      });
    } finally {
      this.closed = true;
    }
  }
}
function lifecycleRequest(
  record: any,
  instanceId: string,
): LifecycleRequest | undefined {
  if (
    record?.instanceId !== instanceId ||
    !Number.isSafeInteger(record.sequence)
  )
    return undefined;
  if (
    record.type === "turn.complete" &&
    text(record.turnId) &&
    typeof record.isAborted === "boolean" &&
    (record.agentId === undefined || text(record.agentId))
  )
    return {
      type: "turn.complete",
      turnId: record.turnId,
      isAborted: record.isAborted,
      ...(record.agentId === undefined ? {} : { agentId: record.agentId }),
    };
  if (
    record.type === "session.end" &&
    ["clear", "resume"].includes(record.reason) &&
    text(record.conversation)
  )
    return {
      type: "session.end",
      reason: record.reason,
      conversation: record.conversation,
    };
  return undefined;
}
function connectedStatus(files: ReturnType<typeof paths>) {
  const status = statusAt(files.status);
  if (!status.connected || !live(status.pid))
    throw new Error("The CUA launcher is disconnected");
  return status;
}
// The failure for a launcher of another plugin version. The command line of
// launcher control ends with its own exit code for it, so the Mod prints
// the message and tries no other session.
export const VERSION_SKEW_EXIT = 3;
export class VersionSkew extends Error {}
// A command that the launcher must read needs a launcher of the version of
// this module. A launcher of another version can lack the command: it then
// reads no request, and the person waits for a result that does not come.
// The check comes before each request file, so no request stays unread.
// The text names no marketplace as the only one: the public marketplace is
// `claude-mod`, and a checkout installs the plugin from `claude-cua-dev`.
function sameVersion(status: ControlStatus) {
  if (status.pluginVersion === PLUGIN_VERSION) return;
  const launcher =
    typeof status.pluginVersion === "string" && status.pluginVersion.length > 0
      ? status.pluginVersion
      : "an earlier version";
  throw new VersionSkew(
    `The CUA launcher of this session runs plugin version ${launcher}, and this command comes from version ${PLUGIN_VERSION}. Update the plugin from the marketplace where you installed it, for example with claude plugin update cua-integration@claude-mod, or with cua-integration@claude-cua-dev for a checkout. Then quit Claude Code or the Claude desktop app and start it again`,
  );
}
// How long an allow-all request can wait for its launcher. A launcher reads
// a request at its next poll, which comes many times in one second.
const REQUEST_STALE_MS = 60_000;
// Removes each allow-all request that no launcher takes. Before issue #101,
// a command for a launcher of another version left its request in the
// control folder, and a later session can have another file prefix. A
// request is abandoned when its launcher is gone, is another instance, or
// has another plugin version, and when the request is older than the wait
// above. A new request for a live launcher of this version stays.
function sweepRequests(root = defaultRoot()) {
  let names: string[];
  try {
    names = readdirSync(root).filter((name) => name.endsWith(SUFFIX_ALLOW_ALL));
  } catch {
    return; // No launcher wrote a control folder yet.
  }
  for (const name of names) {
    const path = join(root, name);
    let abandoned = true;
    try {
      const request = read(path);
      const status = statusAt(
        join(root, `${name.slice(0, -SUFFIX_ALLOW_ALL.length)}.status.json`),
      );
      abandoned =
        request?.instanceId !== status.instanceId ||
        !status.connected ||
        !live(status.pid) ||
        status.pluginVersion !== PLUGIN_VERSION ||
        Date.now() - statSync(path).mtimeMs > REQUEST_STALE_MS;
    } catch {
      // A request or a status that cannot be read belongs to no launcher.
    }
    if (abandoned) rmSync(path, { force: true });
  }
}
const SUFFIX_ALLOW_ALL = ".allow-all.json";
// The last status that the launcher of a session wrote, also after that
// launcher stopped. A stopped launcher keeps there the result of its last
// attempt to stop the Computer Use service. This function changes no file.
export function lastStatus(session: string, root?: string): ControlStatus {
  return statusAt(paths(session, root).status);
}
export function control(session: string, action: string, root?: string) {
  sweepRequests(root);
  const files = paths(session, root);
  const status = connectedStatus(files);
  if (!["status", "on", "off"].includes(action))
    throw new Error("Use status, on, or off");
  if (action !== "status") {
    // An enabled launcher keeps its enable generation at a second `/cua on`.
    // Each other change starts a generation, so no state that is bound to an
    // earlier `/cua on` survives a `/cua off`.
    const current =
      action === "on"
        ? generationAt(files.decision, status.instanceId)
        : undefined;
    write(files.decision, {
      instanceId: status.instanceId,
      enabled: action === "on",
      generation: current ?? randomUUID(),
    });
  }
  // `/cua off` also asks the launcher for one attempt to stop the Computer
  // Use service (decision record 0006). The request follows the disable, so
  // no call starts between the two. A request that launcher control cannot
  // write does not undo the disable: the result names the reason.
  let stop: { stopId: string } | { reason: string } | undefined;
  if (action === "off")
    try {
      stop = { stopId: queueStop(files, status.instanceId, "off") };
    } catch (error) {
      stop = {
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  return {
    ...current(status, files),
    enabled: enabledAt(files.decision, status.instanceId),
    ...(stop ? { stop } : {}),
    // The version of this module, so the Mod can show a difference from the
    // version of the launcher.
    controlVersion: PLUGIN_VERSION,
  };
}
// The status with the allow-all mode as it is now. The launcher writes the
// end of the mode to its status only at its next poll, and the mode ends
// with its enable generation, at `/cua off`. Thus, a status that reports the
// mode as on is correct only while the decision file still has the enable
// generation of the mode. A status with no generation, from a launcher of an
// earlier version, reports the mode as on only while the launcher is
// enabled.
function current(
  status: ControlStatus,
  files: ReturnType<typeof paths>,
): ControlStatus {
  const mode = status.allowAll;
  if (!mode?.on) return status;
  const generation = generationAt(files.decision, status.instanceId);
  const on =
    generation !== undefined &&
    (mode.generation === undefined || mode.generation === generation);
  if (on) return status;
  const { since: _since, generation: _generation, ...rest } = mode;
  return { ...status, allowAll: { ...rest, on: false } };
}
// Asks the connected launcher for one native check and resolves to the
// identifier of that check. The launcher runs the check as its own operation,
// so no caller record belongs to it. A disabled launcher refuses, as it
// refuses a call, and one launcher runs one check at a time.
export function check(session: string, root?: string): { checkId: string } {
  const files = paths(session, root);
  const status = connectedStatus(files);
  sameVersion(status);
  if (!enabledAt(files.decision, status.instanceId))
    throw new Error("CUA is disabled. Run /cua on, then /cua check");
  if (status.nativeCheck?.state === "running")
    throw new Error("A native check already runs in this launcher");
  const checkId = randomUUID();
  // A request of a launcher that stopped names another instance.
  try {
    if (read(files.check)?.instanceId !== status.instanceId)
      rmSync(files.check, { force: true });
  } catch {
    rmSync(files.check, { force: true });
  }
  try {
    create(files.check, { instanceId: status.instanceId, id: checkId });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new Error("A native check already waits for this launcher");
    throw error;
  }
  return { checkId };
}
// Asks the connected launcher to stop the Computer Use service, and resolves
// to the identifier of that request. The launcher makes the attempt as its
// own operation and writes the result to its status. The request needs no
// enabled launcher, because it sends no call, and a person can want to remove
// an agent pointer while CUA is off.
// `cleaned` runs after the cleanup of an old request and before the write of
// the new one, so a test can try a second request at that moment.
export function serviceStop(
  session: string,
  root?: string,
  cleaned?: () => void,
): { stopId: string } {
  const files = paths(session, root);
  const status = connectedStatus(files);
  sameVersion(status);
  return { stopId: queueStop(files, status.instanceId, "command", cleaned) };
}
// Writes the request for one stop attempt, with the command that caused it,
// and returns the identifier of the request. One request waits at a time.
function queueStop(
  files: ReturnType<typeof paths>,
  instanceId: string,
  trigger: "command" | "off",
  cleaned?: () => void,
): string {
  const stopId = randomUUID();
  // Two commands can ask at the same time, for example `/cua off` and
  // `/cua stop-service`. The cleanup of an old request and the write of the
  // new one run under one lock, so no command removes the request that
  // another command wrote between its own read and its own removal.
  const write = () => {
    // A request of a launcher that stopped names another instance. An
    // absent file needs no cleanup.
    let stale = false;
    try {
      stale = read(files.serviceStop)?.instanceId !== instanceId;
    } catch (error) {
      stale = (error as NodeJS.ErrnoException).code !== "ENOENT";
    }
    if (stale) rmSync(files.serviceStop, { force: true });
    cleaned?.();
    try {
      create(files.serviceStop, { instanceId, id: stopId, trigger });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST")
        throw new Error(
          "A stop of the Computer Use service already waits for this launcher",
        );
      throw error;
    }
  };
  try {
    locked(files.serviceStop, write, STOP_REQUEST_LOCK_MS);
  } catch (error) {
    // The lock of another command stayed for the whole wait.
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new Error(
        "Another command writes a stop request for this launcher now",
      );
    throw error;
  }
  return stopId;
}
// How long a command waits while another command writes a stop request.
const STOP_REQUEST_LOCK_MS = 1000;
// Asks the connected launcher to turn the allow-all mode on or off, and
// resolves to the identifier of that request. The launcher changes the mode
// in its memory and writes the result to its status. To turn the mode on,
// the launcher must be enabled, because the mode permits calls to act on
// each app. To turn it off, it need not be.
export function allowAll(
  session: string,
  on: boolean,
  root?: string,
): { requestId: string } {
  const files = paths(session, root);
  const status = connectedStatus(files);
  sweepRequests(root);
  sameVersion(status);
  if (on && !enabledAt(files.decision, status.instanceId))
    throw new Error("CUA is disabled. Run /cua on, then /cua allow-all");
  const requestId = randomUUID();
  // A later request replaces an earlier one that the launcher did not read
  // yet, so the last command of the person decides.
  write(files.allowAll, { instanceId: status.instanceId, id: requestId, on });
  return { requestId };
}
// How long one `allow-all-wait` command waits for the launcher.
export const ALLOW_ALL_WAIT_MS = 5000;
// Waits until the launcher handled the request `requestId`, at most
// `waitMs`, and resolves to the status then. `finished` is false when the
// wait ended first. A launcher that stops ends the wait with an error.
export function allowAllWait(
  session: string,
  requestId: string,
  root?: string,
  waitMs = ALLOW_ALL_WAIT_MS,
) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const status = control(session, "status", root);
    const finished = status.allowAll?.request === requestId;
    if (finished || Date.now() >= deadline) return { ...status, finished };
    Atomics.wait(pause, 0, 0, CHECK_WAIT_POLL_MS);
  }
}
// How long one `stop-service-wait` command waits for the result. An attempt
// waits at most 3 seconds for the exit of the service.
export const SERVICE_STOP_WAIT_MS = 10000;
// Waits until the launcher wrote the result of the request `stopId`, at most
// `waitMs`, and resolves to the status then. `finished` is false when the
// wait ended first. A launcher that stops ends the wait with an error.
export function serviceStopWait(
  session: string,
  stopId: string,
  root?: string,
  waitMs = SERVICE_STOP_WAIT_MS,
) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const status = control(session, "status", root);
    const finished = status.nativeService?.request === stopId;
    if (finished || Date.now() >= deadline) return { ...status, finished };
    Atomics.wait(pause, 0, 0, CHECK_WAIT_POLL_MS);
  }
}
// The results of the native checks that the connected launchers of this user
// hold, most recent first. The prerequisite check reads them, because it runs
// outside a session. A launcher that stopped holds no result, and an unsafe
// or malformed status file reads as absent.
export function checkResults(root = defaultRoot()): CheckResult[] {
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }
  const results: CheckResult[] = [];
  for (const name of names) {
    if (!name.endsWith(".status.json")) continue;
    try {
      const status = statusAt(join(root, name));
      if (!status.connected || !live(status.pid)) continue;
      const permission = status.nativePermission;
      const result = permission?.check ?? permission?.otherRuntime;
      if (result && typeof result.at === "string") results.push(result);
    } catch {
      /* Not a status of a running launcher. */
    }
  }
  return results.sort((a, b) => b.at.localeCompare(a.at));
}
// How long one `check-wait` command waits, and how often it reads the status.
// The Mod repeats the command, because the host bounds one command.
export const CHECK_WAIT_MS = 20000;
const CHECK_WAIT_POLL_MS = 100;
const pause = new Int32Array(new SharedArrayBuffer(4));
// Waits until the launcher finished the check `checkId`, at most `waitMs`,
// and resolves to the status then. `finished` is false when the wait ended
// first. A launcher that stops ends the wait with an error.
export function checkWait(
  session: string,
  checkId: string,
  root?: string,
  waitMs = CHECK_WAIT_MS,
) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const status = control(session, "status", root);
    const finished =
      status.nativeCheck?.id === checkId &&
      status.nativeCheck.state === "finished";
    if (finished || Date.now() >= deadline) return { ...status, finished };
    Atomics.wait(pause, 0, 0, CHECK_WAIT_POLL_MS);
  }
}
// The first answer of the allow-all mode for each app, as the connected
// launcher holds them for the notice of the Mod.
// A report only: no reader takes a decision from it.
export function allowed(session: string, root?: string) {
  const firsts = connectedStatus(paths(session, root)).allowAll?.firsts;
  return Array.isArray(firsts) ? firsts : [];
}
// The approvals that the connected launcher waits on. A list that another
// launcher instance wrote is not this launcher's, so it reads as empty.
export function approvals(session: string, root?: string): ApprovalOffer[] {
  const files = paths(session, root);
  const status = connectedStatus(files);
  if (!existsSync(files.approvals)) return [];
  const list = read(files.approvals);
  if (list?.instanceId !== status.instanceId) return [];
  if (!Array.isArray(list.approvals))
    throw new Error("Malformed approval list");
  return list.approvals;
}
// Records the user's choice for one offered approval, and who answered its
// dialog as the engine reported it. An approval that is no longer offered,
// already answered, or that does not permit the choice is refused, so a stale
// dialog cannot answer a newer request.
export function answer(
  session: string,
  operationId: string,
  choice: string,
  root?: string,
  approver?: string,
) {
  const files = paths(session, root);
  const status = connectedStatus(files);
  const path = files.answer(operationId);
  const offer = approvals(session, root).find(
    (offer) => offer.operationId === operationId,
  );
  if (!offer) throw new Error("This approval expired or already ended");
  if (
    !CHOICES.includes(choice as ApprovalChoice) ||
    !offer.choices.includes(choice as ApprovalChoice)
  )
    throw new Error("This approval does not permit that choice");
  if (approver !== undefined && !APPROVERS.includes(approver as DialogApprover))
    throw new Error("Malformed approver");
  try {
    create(path, {
      instanceId: status.instanceId,
      operationId,
      choice,
      ...(approver === undefined ? {} : { approver }),
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new Error("This approval already has an answer");
    throw error;
  }
  return { operationId, choice };
}
// Records the turn, agent, and conversation of a call that the host is about
// to send. The launcher reads the record when the call arrives.
export function call(
  session: string,
  fields: Omit<CallRecord, "createdAt">,
  root?: string,
): CallRecord {
  const record: CallRecord = { ...fields, createdAt: Date.now() };
  const files = paths(session, root);
  const status = connectedStatus(files);
  if (
    !text(record.toolUseId) ||
    !text(record.turnId) ||
    !text(record.conversation) ||
    (record.agentId !== undefined && !text(record.agentId))
  )
    throw new Error("Malformed call record");
  write(files.call(record.toolUseId), {
    instanceId: status.instanceId,
    ...record,
  });
  return record;
}
// Queues a lifecycle event for the connected launcher. The launcher handles it
// on its own schedule, so a short host callback only has to write the file.
export function lifecycle(
  session: string,
  request: LifecycleRequest,
  root?: string,
): LifecycleRequest {
  const files = paths(session, root);
  const status = connectedStatus(files);
  if (
    !lifecycleRequest(
      { instanceId: status.instanceId, sequence: 0, ...request },
      status.instanceId,
    )
  )
    throw new Error("Malformed lifecycle request");
  // Each request is a separate process, and several can share a millisecond.
  // A counter under the lock orders them as the Mod wrote them, and the file
  // appears under the same lock, so a poll never sees a later number first.
  locked(files.sequence, () => {
    const next = existsSync(files.sequence) ? read(files.sequence)?.next : 1;
    if (!Number.isSafeInteger(next) || next < 1)
      throw new Error("Malformed lifecycle sequence");
    write(files.sequence, { next: next + 1 });
    create(`${files.lifecycle}${randomUUID()}.json`, {
      instanceId: status.instanceId,
      sequence: next,
      ...request,
    });
  });
  return request;
}
export type GrantList = {
  // The session grants of the connected launcher.
  session: SessionGrant[];
  launcherConnected: boolean;
  // The allow-all mode of the connected launcher, when it is on.
  allowAll?: { since: string; answered: number };
  // The grant store of issue #12, when the file still exists. No launcher
  // reads it.
  legacyStore?: LegacyGrantStore;
};
const sessionGrant = (value: any): value is SessionGrant =>
  resource(value?.resource) &&
  typeof value.appName === "string" &&
  ["low", "high"].includes(value.riskLevel);
// Reports the session grants of the connected launcher and the old grant
// store, if one exists. It changes no file. A lasting permission belongs in
// the Codex app, so no command lists or ends one here.
export function grants(
  session: string,
  root?: string,
  legacy: () => LegacyGrantStore | undefined = legacyGrantStore,
): GrantList {
  let status: ControlStatus | undefined;
  try {
    const files = paths(session, root);
    status = current(connectedStatus(files), files);
  } catch {
    status = undefined;
  }
  const store = legacy();
  return {
    session: Array.isArray(status?.sessionGrants)
      ? status.sessionGrants
          .filter(sessionGrant)
          .map(({ resource, appName, riskLevel }) => ({
            resource,
            appName,
            riskLevel,
          }))
      : [],
    launcherConnected: status !== undefined,
    ...(status?.allowAll?.on === true &&
    typeof status.allowAll.since === "string" &&
    Number.isSafeInteger(status.allowAll.answered)
      ? {
          allowAll: {
            since: status.allowAll.since,
            answered: status.allowAll.answered,
          },
        }
      : {}),
    ...(store ? { legacyStore: store } : {}),
  };
}
function run(argv: string[]): unknown {
  const [session, action, ...rest] = argv;
  if (
    session !== undefined &&
    action === "call" &&
    (rest.length === 3 || rest.length === 4)
  )
    return call(session, {
      toolUseId: rest[0]!,
      turnId: rest[1]!,
      conversation: rest[2]!,
      ...(rest[3] === undefined ? {} : { agentId: rest[3] }),
    });
  if (
    session !== undefined &&
    action === "turn-end" &&
    (rest.length === 2 || rest.length === 3) &&
    ["answer", "aborted"].includes(rest[1]!)
  )
    return lifecycle(session, {
      type: "turn.complete",
      turnId: rest[0]!,
      isAborted: rest[1] === "aborted",
      ...(rest[2] === undefined ? {} : { agentId: rest[2] }),
    });
  if (session !== undefined && action === "session-end" && rest.length === 2)
    return lifecycle(session, {
      type: "session.end",
      reason: rest[0]!,
      conversation: rest[1]!,
    });
  if (session !== undefined && action === "check" && rest.length === 0)
    return check(session);
  if (session !== undefined && action === "check-wait" && rest.length === 1)
    return checkWait(session, rest[0]!);
  if (
    session !== undefined &&
    action === "allow-all" &&
    rest.length === 1 &&
    ["on", "off"].includes(rest[0]!)
  )
    return allowAll(session, rest[0] === "on");
  if (session !== undefined && action === "allow-all-wait" && rest.length === 1)
    return allowAllWait(session, rest[0]!);
  if (session !== undefined && action === "stop-service" && rest.length === 0)
    return serviceStop(session);
  if (
    session !== undefined &&
    action === "stop-service-wait" &&
    rest.length === 1
  )
    return serviceStopWait(session, rest[0]!);
  // The Mod reads the offers during a call. The answers of the allow-all
  // mode come with them, so the Mod can show a notice for an app that the
  // mode approved.
  if (session !== undefined && action === "approvals" && rest.length === 0)
    return { approvals: approvals(session), allowed: allowed(session) };
  if (session !== undefined && action === "grants" && rest.length === 0)
    return grants(session);
  if (
    session !== undefined &&
    action === "answer" &&
    (rest.length === 2 || rest.length === 3)
  )
    return answer(session, rest[0]!, rest[1]!, undefined, rest[2]);
  if (session !== undefined && action !== undefined && rest.length === 0)
    return control(session, action);
  throw new Error(
    "Usage: control.ts SESSION status|on|off|approvals|grants|check|stop-service, control.ts SESSION allow-all on|off, control.ts SESSION allow-all-wait REQUEST_ID, control.ts SESSION check-wait CHECK_ID, control.ts SESSION stop-service-wait STOP_ID, control.ts SESSION answer OPERATION_ID CHOICE [person|host|none], control.ts SESSION call TOOL_USE_ID TURN_ID CONVERSATION [AGENT_ID], control.ts SESSION turn-end TURN_ID answer|aborted [AGENT_ID], or control.ts SESSION session-end clear|resume CONVERSATION",
  );
}
// A path through a symlink, such as a linked home directory, names the same
// module. An argument that names no file is not this module.
const main = (() => {
  try {
    return (
      !!process.argv[1] &&
      import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
    );
  } catch {
    return false;
  }
})();
if (main) {
  try {
    process.stdout.write(JSON.stringify(run(process.argv.slice(2))) + "\n");
  } catch (error) {
    process.stderr.write(
      (error instanceof Error ? error.message : "Control failed") + "\n",
    );
    process.exitCode = error instanceof VersionSkew ? VERSION_SKEW_EXIT : 1;
  }
}
