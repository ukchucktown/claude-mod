import { randomUUID } from "node:crypto";
import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

// Files that only the current user can read or write. Launcher control uses
// these rules, because its files decide what can act for the user.

export function privateDirectory(path: string) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.()
  )
    throw new Error("Unsafe private directory");
  chmodSync(path, 0o700);
}
export function read(path: string): any {
  const stat = lstatSync(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o077) !== 0
  )
    throw new Error("Unsafe private file");
  return JSON.parse(readFileSync(path, "utf8"));
}
export function write(path: string, data: unknown) {
  const temporary = `${path}.${randomUUID()}`;
  writeFileSync(temporary, JSON.stringify(data), { mode: 0o600, flag: "wx" });
  renameSync(temporary, path);
}
// Like write, but fails when the file already exists. The link is atomic, so a
// reader never sees a partial file and a second writer never replaces the first.
export function create(path: string, data: unknown) {
  const temporary = `${path}.${randomUUID()}`;
  writeFileSync(temporary, JSON.stringify(data), { mode: 0o600, flag: "wx" });
  try {
    linkSync(temporary, path);
  } finally {
    unlinkSync(temporary);
  }
}
export function live(pid: unknown): boolean {
  if (!Number.isSafeInteger(pid) || (pid as number) <= 0) return false;
  try {
    process.kill(pid as number, 0);
    return true;
  } catch {
    return false;
  }
}
// The lock directory holds the owner's PID. A crash can leave the lock, so a
// lock whose recorded owner no longer runs is recovered. A lock without a
// readable PID, or with a live owner, is never taken.
function lockOwner(lock: string): number | undefined {
  try {
    const pid = Number(readFileSync(join(lock, "pid"), "utf8"));
    return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}
function acquire(lock: string) {
  mkdirSync(lock, { mode: 0o700 });
  writeFileSync(join(lock, "pid"), String(process.pid), { mode: 0o600 });
}
// A second read of the PID before removal is not atomic with the removal, so
// another recoverer could remove a lock that a live process acquired between
// them. The recovery lock admits one recoverer at a time. While it holds that
// lock, no other process can remove or replace the stale lock, so the owner
// that it reads again is the owner that it removes. A crash while the
// recovery lock is held leaves it in place, and the lock then fails closed, as
// a lock without a readable PID does.
function recover(lock: string, conflict: unknown) {
  const owner = lockOwner(lock);
  if (owner === undefined || live(owner)) throw conflict;
  const recovery = `${lock}.recovery`;
  try {
    mkdirSync(recovery, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw conflict;
    throw error;
  }
  try {
    if (lockOwner(lock) !== owner) throw conflict;
    rmSync(lock, { recursive: true, force: true });
    acquire(lock);
  } finally {
    rmSync(recovery, { recursive: true, force: true });
  }
}
const pause = new Int32Array(new SharedArrayBuffer(4));
// Runs action while this process holds the lock for path. A live owner's lock
// fails at once, unless waitMs allows this process to wait for its release.
export function locked<T>(path: string, action: () => T, waitMs = 0): T {
  const lock = `${path}.lock`;
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      acquire(lock);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        recover(lock, error);
        break;
      } catch (conflict) {
        if (Date.now() >= deadline) throw conflict;
        Atomics.wait(pause, 0, 0, 5);
      }
    }
  }
  try {
    return action();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}
