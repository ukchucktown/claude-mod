import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { changesLayout } from "../mod/hooks/display.ts";
import type { NativeApproval } from "./native-approval.ts";

// The Codex app is the only place for a lasting Computer Use permission
// (decision 0002). An app on its always-allow list sends no request to the
// launcher. The launcher keeps an "Allow for this session" answer in memory
// only, so the answer ends with the launcher process, and no file records it.
// The native runtime receives a plain accept for each request, so it keeps no
// answer of its own, and the Codex saved-grants store never changes.

type Risk = "low" | "high";
// A session grant of one launcher.
export type SessionGrant = {
  resource: string;
  appName: string;
  riskLevel: Risk;
};

// A canonical bundle identifier as the native request supplies it. Grants
// compare identifiers exactly, so two spellings never share a grant. An
// identifier holds no character that changes the direction or the layout of
// text.
export const resource = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 256 &&
  value.trim() === value &&
  !changesLayout(value);

// A high-risk grant covers a low-risk request. A low-risk grant does not
// cover a request that the native policy now rates high.
const covers = (granted: Risk, requested: Risk) =>
  granted === "high" || requested === "low";

// How many answers of the allow-all mode the status keeps.
export const ALLOW_ALL_HISTORY = 10;
// How many first answers for an app the status keeps for the notice of the
// Mod. This list is separate from the recent answers, so later answers for
// one app do not remove the first answer for another app before the Mod
// showed it.
export const ALLOW_ALL_FIRSTS = 64;
// One request that the allow-all mode answered.
export type AllowAllAnswer = {
  // The number of the answer in this launcher, from 1.
  seq: number;
  at: string;
  resource: string;
  appName: string;
  operation: string;
  riskLevel: Risk;
  // True for the first answer for this app since the mode went on.
  firstForApp: boolean;
};
// The allow-all mode of one launcher (decision record 0007): whether it is
// on, since when, how many requests it answered in this launcher, and the
// most recent answers, oldest first.
export type AllowAllStatus = {
  on: boolean;
  since?: string;
  answered: number;
  recent: AllowAllAnswer[];
  // The first answer for each app since the mode went on, oldest first, for
  // the notice of the Mod. The list keeps the most recent entries.
  firsts: AllowAllAnswer[];
};

// The session grants of one launcher, and its allow-all mode. The runtimes of
// all callers share them, and they end with the launcher process. Nothing
// here reads or writes a file.
export class SessionGrants {
  private grants = new Map<string, SessionGrant>();
  // The allow-all mode: an answer of the person in advance, for each app. It
  // is on only between the command of a person that turns it on and the
  // command that turns it off, and a new launcher starts with the mode off.
  private all:
    | { since: string; apps: Set<string>; valid: () => boolean }
    | undefined;
  private answered = 0;
  private recent: AllowAllAnswer[] = [];
  private firsts: AllowAllAnswer[] = [];
  // Turns the mode on or off. Returns whether the state changed. `valid`
  // binds the mode to a condition of the launcher: the mode ends at the
  // first use or report for which the condition is false. The launcher
  // binds the mode to the enable generation of the `/cua on` under which
  // the person turned the mode on, so each `/cua off` ends the mode.
  setAllowAll(on: boolean, valid: () => boolean = () => true): boolean {
    if (!on) {
      if (this.all === undefined) return false;
      this.all = undefined;
      return true;
    }
    // A second command keeps the start time and takes the new condition.
    if (this.all !== undefined) {
      this.all.valid = valid;
      return false;
    }
    this.all = { since: new Date().toISOString(), apps: new Set(), valid };
    return true;
  }
  // The mode, after a check of its condition. A condition that is false, or
  // that fails, ends the mode.
  private mode() {
    if (this.all === undefined) return undefined;
    let valid = false;
    try {
      valid = this.all.valid();
    } catch {
      valid = false;
    }
    if (!valid) this.all = undefined;
    return this.all;
  }
  // Whether the mode answers this request now. The mode answers exactly the
  // requests that a session grant can answer: the request must permit
  // session persistence. The risk level does not matter, because the person
  // answered for each app and each operation.
  allowsAll(approval: NativeApproval): boolean {
    return this.mode() !== undefined && approval.scopes.includes("session");
  }
  // Records one request that the mode answered. The mode keeps no session
  // grant for the app, so the dialog returns when the mode goes off.
  recordAllowed(approval: NativeApproval): AllowAllAnswer {
    const answer: AllowAllAnswer = {
      seq: ++this.answered,
      at: new Date().toISOString(),
      resource: approval.appId,
      appName: approval.appName,
      operation: approval.operation,
      riskLevel: approval.riskLevel,
      firstForApp: !(this.all?.apps.has(approval.appId) ?? false),
    };
    this.all?.apps.add(approval.appId);
    this.recent.push(answer);
    if (this.recent.length > ALLOW_ALL_HISTORY) this.recent.shift();
    if (answer.firstForApp) {
      this.firsts.push(answer);
      if (this.firsts.length > ALLOW_ALL_FIRSTS) this.firsts.shift();
    }
    return answer;
  }
  allowAllStatus(): AllowAllStatus {
    const mode = this.mode();
    return {
      on: mode !== undefined,
      ...(mode ? { since: mode.since } : {}),
      answered: this.answered,
      recent: structuredClone(this.recent),
      firsts: structuredClone(this.firsts),
    };
  }
  // Whether a session grant answers this request now. The request must still
  // permit session persistence, so a policy change that withdraws it also
  // withdraws reuse.
  reuse(approval: NativeApproval): boolean {
    const grant = this.grants.get(approval.appId);
    return (
      grant !== undefined &&
      approval.scopes.includes("session") &&
      covers(grant.riskLevel, approval.riskLevel)
    );
  }
  // Records the "Allow for this session" answer of the user. A later answer
  // for the same app replaces the earlier one.
  record(approval: NativeApproval) {
    this.grants.set(approval.appId, {
      resource: approval.appId,
      appName: approval.appName,
      riskLevel: approval.riskLevel,
    });
  }
  list(): SessionGrant[] {
    return structuredClone([...this.grants.values()]);
  }
}

// The grant store that issue #12 wrote. This version never reads it for a
// decision and never writes it. Launcher control reports the file, so a user
// can move its apps to the always-allow list of the Codex app and delete it.
export function legacyGrantStorePath(): string {
  return join(
    homedir(),
    "Library",
    "Application Support",
    "claude-cua-mod",
    "grants.json",
  );
}
export type LegacyGrantStore = {
  path: string;
  // The apps that the file grants permanently, when its content is readable.
  apps?: string[];
};
// Reports the old store at path, or undefined when no file exists. The
// report changes no file: removal stays a decision of the user.
export function legacyGrantStore(
  path = legacyGrantStorePath(),
): LegacyGrantStore | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return { path };
  }
  try {
    const grants: unknown = JSON.parse(text)?.grants;
    if (!Array.isArray(grants)) return { path };
    const apps = grants.map((grant) => grant?.resource);
    return apps.every(resource) ? { path, apps } : { path };
  } catch {
    return { path };
  }
}
