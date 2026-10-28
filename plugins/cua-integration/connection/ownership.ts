import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  live,
  locked,
  privateDirectory,
  read,
  write,
} from "../private-files.ts";

// Separate runtime processes do not isolate their effects on the same Mac.
// Every runtime of every launcher of this user therefore takes the lease of
// one canonical resource before it acts, and the native guard refuses each
// native request of a runtime that does not hold that lease. The native
// driver has no verified concurrency between apps: keys, text, and focus can
// cross from one app to another. So the computer profile has a single
// resource, the desktop of this user, and calls of separate sessions run one
// at a time even when they name different apps.
export const DESKTOP_RESOURCE = "native:desktop";
export const OWNERSHIP_VERSION = 1;
// How long a call waits for the lease before it fails without effect.
export const OWNERSHIP_WAIT_MS = 30000;
// How many runtimes, in all launchers, can wait for one resource. A runtime
// over the limit fails at once, without effect.
export const OWNERSHIP_QUEUE_LIMIT = 8;
// How often a waiter checks the lease again.
export const OWNERSHIP_POLL_MS = 25;
// How long one change waits while another process changes the record.
const RECORD_LOCK_WAIT_MS = 1000;
// The environment variables that tell the native guard its lease file and
// its connection. The guard refuses each native request without them.
export const OWNERSHIP_ENV = "CLAUDE_CUA_OWNERSHIP";
export const CONNECTION_ENV = "CLAUDE_CUA_CONNECTION";

// The runtime that holds the lease, and the call that it acts for. The
// processes decide when the lease is stale: while the launcher, its runtime,
// or a process that the runtime started still runs, the old executor can
// still act, so no other runtime takes over.
export type Holder = {
  holderId: string;
  // The native session identity of the runtime connection.
  connection: string;
  launcherPid: number;
  runtimePid?: number;
  // The descendants of the runtime process when the holder took the lease.
  // The installed runtime starts its executor with inherited standard
  // streams, so the executor can outlive the runtime process.
  executorPids?: number[];
  sessionId: string;
  agentId?: string;
  toolUseId: string;
  acquiredAt: string;
};
export type Waiter = { waiterId: string; ticket: number; launcherPid: number };
export type OwnershipRecord = {
  version: typeof OWNERSHIP_VERSION;
  resource: string;
  // Changes each time the lease passes to another connection. An observation
  // from an earlier epoch can describe an app that another runtime changed.
  epoch: string;
  holder?: Holder;
  // The connection of the last holder.
  previous?: string;
  // The waiters in arrival order. The first live waiter takes a free lease.
  queue: Waiter[];
  nextTicket: number;
};
export type Claim = {
  connection: string;
  runtimePid?: number;
  executorPids?: number[];
  sessionId: string;
  agentId?: string;
  toolUseId: string;
};

// Kinds name the cause of a refusal, not its severity. Each refusal occurs
// before the call reaches the runtime, so the call had no effect.
export class OwnershipError extends Error {
  readonly kind: "busy" | "timeout" | "aborted" | "invalid";
  constructor(kind: OwnershipError["kind"], message: string) {
    super(message);
    this.name = "OwnershipError";
    this.kind = kind;
  }
}

export function ownershipRoot() {
  return join(tmpdir(), `claude-cua-${process.getuid?.()}`);
}
export function ownershipPath(resource: string, root = ownershipRoot()) {
  const key = createHash("sha256").update(resource).digest("hex");
  return join(root, `resource.${key}.json`);
}

const text = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 1024;
const pid = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) > 0;
function holderOf(value: any): Holder {
  if (
    !text(value?.holderId) ||
    !text(value.connection) ||
    !pid(value.launcherPid) ||
    (value.runtimePid !== undefined && !pid(value.runtimePid)) ||
    (value.executorPids !== undefined &&
      (!Array.isArray(value.executorPids) ||
        value.executorPids.length > MAX_EXECUTORS ||
        !value.executorPids.every(pid))) ||
    !text(value.sessionId) ||
    (value.agentId !== undefined && !text(value.agentId)) ||
    !text(value.toolUseId) ||
    !text(value.acquiredAt)
  )
    throw new Error("malformed holder");
  return value;
}
export function parseOwnership(value: any, resource: string): OwnershipRecord {
  if (
    value?.version !== OWNERSHIP_VERSION ||
    value.resource !== resource ||
    !text(value.epoch) ||
    (value.previous !== undefined && !text(value.previous)) ||
    !Array.isArray(value.queue) ||
    !Number.isSafeInteger(value.nextTicket) ||
    value.nextTicket < 1
  )
    throw new Error("malformed ownership record");
  if (value.holder !== undefined) holderOf(value.holder);
  for (const waiter of value.queue)
    if (
      !text(waiter?.waiterId) ||
      !Number.isSafeInteger(waiter.ticket) ||
      !pid(waiter.launcherPid)
    )
      throw new Error("malformed ownership waiter");
  return value;
}
// A holder is stale only when none of its processes runs.
export const staleHolder = (holder: Holder) =>
  !live(holder.launcherPid) &&
  (holder.runtimePid === undefined || !live(holder.runtimePid)) &&
  !(holder.executorPids ?? []).some(live);
// The most descendants that one holder records.
const MAX_EXECUTORS = 64;
// The processes that the runtime process started, at any depth. The process
// table is the only record that survives a crash of the launcher, so a
// failed read refuses the lease instead of a holder without its executor.
export function descendants(root: number): number[] {
  let table: string;
  try {
    table = execFileSync("/bin/ps", ["-A", "-o", "pid=,ppid="], {
      encoding: "utf8",
      timeout: 5000,
    });
  } catch {
    throw new OwnershipError(
      "invalid",
      "The process table is unreadable, so the executor of this runtime is unknown; this call did not run",
    );
  }
  const children = new Map<number, number[]>();
  for (const line of table.split("\n")) {
    const [child, parent] = line.trim().split(/\s+/).map(Number);
    if (!pid(child) || !pid(parent)) continue;
    children.set(parent, [...(children.get(parent) ?? []), child]);
  }
  const found: number[] = [];
  const pending = [root];
  while (pending.length > 0 && found.length < MAX_EXECUTORS) {
    for (const child of children.get(pending.shift()!) ?? []) {
      if (found.includes(child)) continue;
      found.push(child);
      pending.push(child);
    }
  }
  return found.slice(0, MAX_EXECUTORS);
}

// One acquired lease. Release is idempotent. A runtime whose state is unknown
// releases only after its process exits.
export class Lease {
  readonly holderId: string;
  readonly epoch: string;
  private ownership: ResourceOwnership;
  private released = false;
  constructor(ownership: ResourceOwnership, holderId: string, epoch: string) {
    this.ownership = ownership;
    this.holderId = holderId;
    this.epoch = epoch;
  }
  release() {
    if (this.released) return;
    this.released = true;
    this.ownership.release(this.holderId);
  }
  releaseAfter(exited: Promise<void>) {
    void exited.then(() => this.release());
  }
}

export class ResourceOwnership {
  readonly resource: string;
  readonly path: string;
  private root: string;
  private waitMs: number;
  private queueLimit: number;
  private pollMs: number;
  constructor(
    options: {
      resource?: string;
      root?: string;
      waitMs?: number;
      queueLimit?: number;
      pollMs?: number;
    } = {},
  ) {
    this.resource = options.resource ?? DESKTOP_RESOURCE;
    this.root = options.root ?? ownershipRoot();
    this.path = ownershipPath(this.resource, this.root);
    this.waitMs = options.waitMs ?? OWNERSHIP_WAIT_MS;
    this.queueLimit = options.queueLimit ?? OWNERSHIP_QUEUE_LIMIT;
    this.pollMs = options.pollMs ?? OWNERSHIP_POLL_MS;
  }
  view(): OwnershipRecord | undefined {
    if (!existsSync(this.path)) return undefined;
    return parseOwnership(read(this.path), this.resource);
  }
  // Runs one change of the record under the record lock. Waiters of a
  // launcher that no longer runs leave the queue, and a stale holder loses
  // the lease, so a crash never blocks the resource for good. The record is
  // written only when the change altered it.
  private change<T>(action: (record: OwnershipRecord) => T): T {
    privateDirectory(this.root);
    return locked(
      this.path,
      () => {
        let found: OwnershipRecord | undefined;
        try {
          found = this.view();
        } catch (error) {
          throw new OwnershipError(
            "invalid",
            `The ownership record ${this.path} is invalid (${error instanceof Error ? error.message : String(error)}); no runtime can act until it is removed`,
          );
        }
        const before = found === undefined ? undefined : JSON.stringify(found);
        const record = found ?? {
          version: OWNERSHIP_VERSION,
          resource: this.resource,
          epoch: randomUUID(),
          queue: [],
          nextTicket: 1,
        };
        record.queue = record.queue.filter((waiter) =>
          live(waiter.launcherPid),
        );
        if (record.holder && staleHolder(record.holder)) {
          record.previous = record.holder.connection;
          delete record.holder;
        }
        const result = action(record);
        if (
          found === undefined
            ? record.queue.length > 0 || record.holder !== undefined
            : JSON.stringify(record) !== before
        )
          write(this.path, record);
        return result;
      },
      RECORD_LOCK_WAIT_MS,
    );
  }
  // Waits in arrival order until the lease is free and this waiter is first.
  // The wait ends with a refusal at the limit, at the deadline, or when the
  // signal aborts. A refused call never reached the runtime.
  async acquire(claim: Claim, signal?: AbortSignal): Promise<Lease> {
    const waiterId = randomUUID();
    if (signal?.aborted)
      throw new OwnershipError("aborted", "The runtime stopped");
    // A holder that fails the record check would block every runtime, so a
    // claim that would write one fails here.
    try {
      holderOf({
        ...claim,
        holderId: waiterId,
        launcherPid: process.pid,
        acquiredAt: new Date().toISOString(),
      });
    } catch {
      throw new OwnershipError("invalid", "Malformed ownership claim");
    }
    this.change((record) => {
      if (record.queue.length >= this.queueLimit)
        throw new OwnershipError(
          "busy",
          `${record.queue.length} other calls already wait for the computer; this call did not run`,
        );
      record.queue.push({
        waiterId,
        ticket: record.nextTicket++,
        launcherPid: process.pid,
      });
    });
    const deadline = Date.now() + this.waitMs;
    try {
      for (;;) {
        const lease = !this.mayTake(waiterId)
          ? undefined
          : this.change((record) => {
              if (record.holder || record.queue[0]?.waiterId !== waiterId)
                return undefined;
              record.queue.shift();
              const holderId = randomUUID();
              if (record.previous !== claim.connection)
                record.epoch = randomUUID();
              record.holder = {
                holderId,
                connection: claim.connection,
                launcherPid: process.pid,
                ...(claim.runtimePid === undefined
                  ? {}
                  : { runtimePid: claim.runtimePid }),
                ...(claim.executorPids === undefined
                  ? {}
                  : { executorPids: claim.executorPids }),
                sessionId: claim.sessionId,
                ...(claim.agentId === undefined
                  ? {}
                  : { agentId: claim.agentId }),
                toolUseId: claim.toolUseId,
                acquiredAt: new Date().toISOString(),
              };
              return new Lease(this, holderId, record.epoch);
            });
        if (lease) return lease;
        if (signal?.aborted)
          throw new OwnershipError("aborted", "The runtime stopped");
        if (Date.now() >= deadline)
          throw new OwnershipError(
            "timeout",
            `Another Claude Code session or agent controlled the computer for ${Math.round(this.waitMs / 1000)} seconds; this call did not run`,
          );
        await new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", done);
            resolve();
          };
          const timer = setTimeout(done, this.pollMs);
          signal?.addEventListener("abort", done, { once: true });
        });
      }
    } catch (error) {
      try {
        this.change((record) => {
          record.queue = record.queue.filter(
            (waiter) => waiter.waiterId !== waiterId,
          );
        });
      } catch {
        /* A waiter of a stopped launcher leaves the queue at the next change. */
      }
      throw error;
    }
  }
  // Whether a locked change could give this waiter the lease now. The check
  // reads the record without the lock, so a waiter that must keep waiting
  // writes nothing, not even the lock. An unreadable record takes the locked
  // path, which reports it.
  private mayTake(waiterId: string): boolean {
    let record: OwnershipRecord | undefined;
    try {
      record = this.view();
    } catch {
      return true;
    }
    if (!record) return true;
    if (record.holder && !staleHolder(record.holder)) return false;
    const first = record.queue[0];
    return (
      first === undefined ||
      first.waiterId === waiterId ||
      !live(first.launcherPid)
    );
  }
  // Frees the lease when this holder still has it. A release cannot fail the
  // call that it follows: a lease that stays recorded expires with its
  // processes.
  release(holderId: string) {
    try {
      this.change((record) => {
        if (record.holder?.holderId !== holderId) return;
        record.previous = record.holder.connection;
        delete record.holder;
      });
    } catch {
      /* The holder becomes stale when its launcher and runtime exit. */
    }
  }
}
