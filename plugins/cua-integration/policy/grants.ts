import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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
// compare identifiers exactly, so two spellings never share a grant.
export const resource = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 256 &&
  value.trim() === value &&
  !/[\u0000-\u001f\u007f]/.test(value);

// A high-risk grant covers a low-risk request. A low-risk grant does not
// cover a request that the native policy now rates high.
const covers = (granted: Risk, requested: Risk) =>
  granted === "high" || requested === "low";

// The session grants of one launcher. The runtimes of all callers share them,
// and they end with the launcher process.
export class SessionGrants {
  private grants = new Map<string, SessionGrant>();
  // Whether a session grant answers this request now. The request must still
  // permit session persistence, so a policy change that withdraws it also
  // withdraws reuse.
  reuse(approval: NativeApproval): boolean {
    const grant = this.grants.get(approval.appId);
    return (
      approval.kind === "app" &&
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
