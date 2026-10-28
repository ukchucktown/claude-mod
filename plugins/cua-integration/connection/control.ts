import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  readdirSync,
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
  type LegacyGrantStore,
  type SessionGrant,
} from "../policy/grants.ts";
import {
  create,
  live,
  locked,
  privateDirectory,
  read,
  write,
} from "../private-files.ts";
import type { FailureCategory } from "./diagnostics.ts";
import { ConnectionError } from "./protocol.ts";

export type ControlStatus = {
  instanceId: string;
  pid: number;
  connected: boolean;
  runtimeReady: boolean;
  runtimeGeneration?: string;
  active: number;
  pending: number;
  // How many caller runtimes the launcher keeps: the main loop's and one for
  // each subagent that called recently.
  runtimes?: number;
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
  // The most recent answers of the Mod, oldest first, each with who answered
  // its dialog as the engine reported it to the Mod. This is evidence for a
  // record. No reader takes a decision from it.
  dialogAnswers?: DialogAnswer[];
  nativePermission: "unverified";
  taskSuccess: "unverified";
};
function paths(
  session: string,
  root = join(tmpdir(), `claude-cua-${process.getuid?.()}`),
) {
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
      connected: true,
      runtimeReady: false,
      active: 0,
      pending: 0,
      lastCall: "none",
      nativePermission: "unverified",
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
    try {
      // The session grants end with this launcher, so the status of a
      // stopped launcher lists none.
      this.publish({
        connected: false,
        runtimeReady: false,
        active: 0,
        pending: 0,
        sessionGrants: [],
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
export function control(session: string, action: string, root?: string) {
  const files = paths(session, root);
  const status = connectedStatus(files);
  if (!["status", "on", "off"].includes(action))
    throw new Error("Use status, on, or off");
  if (action !== "status")
    write(files.decision, {
      instanceId: status.instanceId,
      enabled: action === "on",
    });
  return { ...status, enabled: enabledAt(files.decision, status.instanceId) };
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
    status = connectedStatus(paths(session, root));
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
  if (session !== undefined && action === "approvals" && rest.length === 0)
    return { approvals: approvals(session) };
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
    "Usage: control.ts SESSION status|on|off|approvals|grants, control.ts SESSION answer OPERATION_ID CHOICE [person|host|none], control.ts SESSION call TOOL_USE_ID TURN_ID CONVERSATION [AGENT_ID], control.ts SESSION turn-end TURN_ID answer|aborted [AGENT_ID], or control.ts SESSION session-end clear|resume CONVERSATION",
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
    process.exitCode = 1;
  }
}
