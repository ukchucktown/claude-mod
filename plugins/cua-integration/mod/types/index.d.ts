export type Snapshot = {
  enabled: boolean;
  connected: boolean;
  runtimeReady: boolean;
  active: number;
  pending: number;
  lastCall: string;
  error?: string;
  // The review state of the runtime packages, when a runtime exists.
  runtimeReview?: {
    mode: string;
    unreviewedPackages: Record<string, string>;
  };
  // The recoveries of the launcher: runtime failures after which the launcher
  // stayed connected. Absent before the first recovery.
  recovery?: {
    count: number;
    inRow: number;
    limit: number;
    recent: Array<{
      at: string;
      reason: string;
      caller: string;
      restartedAt?: string;
    }>;
  };
  // The last attempt of the launcher to stop the Computer Use service, with
  // its result. Absent before the first attempt.
  nativeService?: {
    at: string;
    outcome: string;
    pids?: number[];
    reason?: string;
    // The cause of the attempt, and the request of an attempt of the command.
    trigger?: string;
    request?: string;
  };
  // The native check that runs now, or the last one that finished.
  nativeCheck?: { id: string; state: string };
  // The native permission of the current runtime, from the last check of the
  // launcher. A status of an earlier version holds the text "unverified".
  nativePermission?: NativePermission | string;
};
// The result of the native check for one capability.
export type Capability = { state: string; failure?: string; reason?: string };
// One finished native check, as launcher control prints it.
export type CheckResult = {
  id: string;
  app: string;
  at: string;
  runtime?: { pluginVersion: string; packages: Record<string, string> };
  accessibility: Capability;
  screenCapture: Capability;
  approvals: { dialogs: number; sessionGrant: number };
  document?: string;
  window: string;
  fileRemoved: boolean;
};
export type NativePermission = {
  accessibility: Capability;
  screenCapture: Capability;
  // The last check, when it ran with the current runtime.
  check?: CheckResult;
  // The last check, when it ran with another runtime version.
  otherRuntime?: CheckResult;
};
// The launcher's approval choices and offers, as launcher control prints them.
export type Choice = "once" | "session" | "decline" | "cancel";
export type Offer = {
  operationId: string;
  // The form of the offer. The Mod shows only the form "app".
  kind: "app";
  // The bundle identifier and the name of the app.
  appId: string;
  appName: string;
  operation: string;
  riskLevel: string;
  choices: Choice[];
};
// The grant report that launcher control prints: the session grants of the
// connected launcher, and the grant store of an earlier version, if one exists.
export type GrantList = {
  session: Array<{ resource: string; appName: string; riskLevel: string }>;
  launcherConnected: boolean;
  legacyStore?: { path: string; apps?: string[] };
};
declare module "claude-code" {
  interface PluginState {
    "cua-integration": {
      status: Snapshot;
      // The single launcher session that a Mod before issue #9 held.
      launcherSession: string;
      // Session IDs under which a launcher can be registered, most recent first.
      launcherSessions: string[];
    };
  }
}
