export type Snapshot = {
  enabled: boolean;
  connected: boolean;
  runtimeReady: boolean;
  active: number;
  pending: number;
  lastCall: string;
  error?: string;
};
// The launcher's approval choices and offers, as launcher control prints them.
export type Choice = "once" | "session" | "decline" | "cancel";
export type Offer = {
  operationId: string;
  // An app request names a bundle identifier and app name. A browser request
  // names its resource and the browser name in the same fields: an origin
  // for an origin, download, or upload request, and "browsing_history" for a
  // history request.
  kind: "app" | "origin" | "history" | "download" | "upload";
  appId: string;
  appName: string;
  operation: string;
  riskLevel: string;
  choices: Choice[];
  // The request facts beyond the resource, such as the search terms of a
  // history request.
  detail?: string;
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
