import type { EngineInterface, Register } from "claude-code";

import type { Choice, GrantList, Offer, Snapshot } from "../types/index.d.ts";

const REF = { plugin: "cua-integration", key: "status" } as const;
// Host state survives a hot reload of the Mod, while a module variable does
// not. A launcher registers under the session ID that was current when it
// started, and keeps that ID after /clear or /resume. A launcher that the user
// reconnects through /mcp starts under the session ID of that moment. So the
// Mod keeps the recent session IDs under which a launcher can be registered,
// most recent first, and a reloaded Mod reads them here.
const LAUNCHER_SESSIONS = {
  plugin: "cua-integration",
  key: "launcherSessions",
} as const;
// The single session ID that a Mod before issue #9 held. A reload from that
// version reads it once.
const LAUNCHER_SESSION = {
  plugin: "cua-integration",
  key: "launcherSession",
} as const;
// How many session IDs the Mod keeps as places to look for its launcher.
const KNOWN_SESSIONS = 5;
const TOOLS = [
  "mcp__plugin_cua-integration_cua__js",
  "mcp__plugin_cua-integration_cua__js_reset",
  "mcp__plugin_cua-integration_cua__js_add_node_module_dir",
];
const DENIED =
  "CUA is disabled or its control gate failed. Use /cua status in the interactive CLI or in Claude Code Desktop.";
// The host's question dialog. The Mod asks for each approval through it.
const ASK_TOOL = "AskUserQuestion";
// The refusal where Claude Code reports that no person answers in the session,
// for example under a host program that answers permission questions itself.
const NO_PERSON =
  "CUA refused this call: Claude Code reports that no person answers the questions of this session. CUA runs only where a person answers its approval dialog.";
// The refusal outside the supported profiles. Only the interactive terminal
// CLI and Claude Code Desktop can show the approval dialog to a person, so no
// other surface reaches the launcher.
const UNSUPPORTED =
  "CUA refused this call: it runs only in the interactive terminal Claude Code CLI and in Claude Code Desktop, which can show its approval dialog. This session cannot show that dialog. VS Code, remote, and headless sessions are unsupported.";
// The refusal while a remote client, such as Remote Control, draws the session
// beside the terminal. The approval dialog could then show and take an answer
// on a surface that the release does not support.
const REMOTE =
  "CUA refused this call: a remote client, such as Remote Control or Claude Desktop, is attached to this session. CUA runs only while the interactive terminal is the only surface of the session. Detach the remote client, then try again.";
// The refusal while another client draws a Desktop session beside Desktop.
const DESKTOP_REMOTE =
  "CUA refused this call: a remote client, such as Remote Control, is attached to this Claude Code Desktop session. CUA runs only while Desktop is the only surface of the session. Detach the remote client, then try again.";
// How a session started, from session.start. The interactive CLI starts on
// the terminal. Claude Code Desktop runs Claude Code as an SDK host, which
// starts with no surface and no person at a prompt, and then attaches Desktop
// as its client. A -p run and other SDK hosts start the same way, but no
// Desktop client attaches to them.
type Start = "terminal" | "sdk";
// The one surface list under which each start may run a call.
const SOLE_SURFACE = {
  terminal: "terminal",
  sdk: "desktop",
} as const satisfies Record<Start, string>;
// How often a running call checks launcher control for an approval request.
const APPROVAL_POLL_MS = 250;
// The key of the main loop in the map of current turns. A subagent's key is
// its agent ID.
const MAIN_LOOP = "";
// A clear or resume shares one short session-end bound with every other hook.
// Below this remainder the Mod leaves the transition to the launcher, which
// detects the new conversation at its next call.
const SESSION_END_RESERVE_MS = 500;

// After /clear or /resume the process continues under a new session ID, but the
// launcher keeps the ID it started with. Try the current ID first, then the
// known session IDs, most recent first. A failed lookup has no side effect,
// because control.ts writes a decision only for a connected launcher.
async function sessions($: EngineInterface, known: readonly string[]) {
  return [...new Set([await $.session.id(), ...known])];
}
// Puts a session ID first in the known list and stores the list in host state.
// The list in memory serves this module even when the host refuses the write,
// for example when a hot reload did not reread the Mod's state contract.
async function remember($: EngineInterface, known: string[], session: string) {
  if (known[0] === session) return;
  const index = known.indexOf(session);
  if (index >= 0) known.splice(index, 1);
  known.unshift(session);
  known.length = Math.min(known.length, KNOWN_SESSIONS);
  try {
    await $.state.set(LAUNCHER_SESSIONS, [...known]);
  } catch {
    /* A later reload starts from the session-start ID again. */
  }
}
// Reads the known sessions that host state holds from before a reload.
async function heldSessions($: EngineInterface): Promise<string[]> {
  try {
    const held = (await $.state.get(LAUNCHER_SESSIONS)).value;
    if (Array.isArray(held)) return held;
    const legacy = (await $.state.get(LAUNCHER_SESSION)).value;
    return legacy === undefined ? [] : [legacy];
  } catch {
    return [];
  }
}
// Runs launcher control under the current or a known session ID, and keeps the
// session ID where it found the launcher.
async function lookup($: EngineInterface, args: string[], known: string[]) {
  const found = await controlRun($, args, await sessions($, known));
  await remember($, known, found.session);
  return found;
}
// Runs launcher control for the first session that a launcher serves. The
// result names that session, so a follow-up action reaches the same launcher.
// A failure of launcher control. `missing` is true when no launcher runs
// under any candidate session: launcher control found no status, or the
// status of a launcher that stopped.
class ControlError extends Error {
  readonly missing: boolean;
  constructor(message: string, missing: boolean) {
    super(message);
    this.missing = missing;
  }
}
const NO_LAUNCHER = [
  "The CUA launcher is disconnected",
  "ENOENT: no such file or directory",
];
async function controlRun(
  $: EngineInterface,
  args: string[],
  candidates: string[],
): Promise<{ value: unknown; session: string }> {
  let failure = "Launcher control failed";
  let missing = candidates.length > 0;
  for (const session of candidates) {
    const attempt = await $.process.run([
      "node",
      `${$.plugin.root}/connection/control.ts`,
      session,
      ...args,
    ]);
    if (attempt.exitCode === 0 && !attempt.isStdoutTruncated)
      return { value: JSON.parse(attempt.stdout), session };
    failure = attempt.stderr.trim() || failure;
    missing &&= NO_LAUNCHER.some((text) => failure.startsWith(text));
  }
  throw new ControlError(failure, missing);
}
const isMissing = (error: unknown) =>
  error instanceof ControlError && error.missing;
// Lists the grants. Launcher control answers under any session ID, but only
// the session of the connected launcher reports its session grants. So every
// known session is tried before the list without a launcher, and only the
// launcher's session becomes the most recent known session.
async function grantList(
  $: EngineInterface,
  known: string[],
): Promise<GrantList> {
  let fallback: GrantList | undefined;
  let failure: unknown;
  for (const session of await sessions($, known)) {
    let list: GrantList;
    try {
      list = (await controlRun($, ["grants"], [session])).value as GrantList;
    } catch (error) {
      failure ??= error;
      continue;
    }
    if (list.launcherConnected) {
      await remember($, known, session);
      return list;
    }
    fallback ??= list;
  }
  if (fallback) return fallback;
  throw failure;
}
async function snapshot(
  $: EngineInterface,
  action: string,
  known: string[],
): Promise<Snapshot> {
  const value = (await lookup($, [action], known)).value as Snapshot;
  if (
    !value ||
    typeof value.enabled !== "boolean" ||
    typeof value.connected !== "boolean" ||
    typeof value.runtimeReady !== "boolean" ||
    !Number.isSafeInteger(value.active) ||
    !Number.isSafeInteger(value.pending) ||
    typeof value.lastCall !== "string"
  )
    throw new Error("Malformed launcher status");
  return value;
}
async function display($: EngineInterface, value: Snapshot) {
  await $.state.set(REF, value);
  $.ui.status(
    `CUA ${value.enabled ? "on" : "off"} | ${value.pending ? "approval pending" : value.active ? "active" : value.lastCall === "failed" ? "failed" : value.runtimeReady ? "runtime ready" : "not ready"}`,
  );
}
function text(value: Snapshot, registered: boolean): string {
  return [
    `CUA: ${value.enabled ? "enabled" : "disabled"}.`,
    `Tools registered: ${registered ? "yes" : "no"}. Launcher connected: ${value.connected ? "yes" : "no"}. Runtime ready: ${value.runtimeReady ? "yes" : "no"}.`,
    `Active calls: ${value.active}. Pending approvals: ${value.pending}. Last call: ${value.lastCall}.`,
    "Native permission: unverified. Task completion: unverified. A completed call does not prove a completed task.",
    ...(value.error ? [`Error: ${value.error}`] : []),
  ].join("\n");
}
// Why the session cannot run a call now, or undefined when it can. A start
// outside both profiles never can. Otherwise the start's own surface must be
// the only surface that draws the session. Clients attach and detach at any
// time, so each check reads the current list. An empty list, as in a -p run,
// fails this check. A failed query rejects, and the caller refuses.
async function surfaceRefusal(
  $: EngineInterface,
  start: Start | undefined,
): Promise<string | undefined> {
  if (!start) return UNSUPPORTED;
  const surfaces = await $.session.surfaces();
  const sole = SOLE_SURFACE[start];
  if (surfaces.length === 1 && surfaces[0] === sole) return undefined;
  if (start === "terminal") return REMOTE;
  // An SDK start without a Desktop client is a headless run or another host.
  return surfaces.includes(sole) ? DESKTOP_REMOTE : UNSUPPORTED;
}
// The launcher gate of a call: `allow`, `deny`, or `missing` when no launcher
// runs, for example after an interrupted call stopped it.
async function gate(
  $: EngineInterface,
  ready: boolean,
  known: string[],
): Promise<"allow" | "deny" | "missing"> {
  if (!ready) return "deny";
  let value: Snapshot;
  try {
    value = await snapshot($, "status", known);
  } catch (error) {
    if (isMissing(error)) return "missing";
    throw error;
  }
  // The launcher performs bootstrap after reset. A stale readiness snapshot
  // must not block the call that restores readiness.
  return value.enabled && value.connected ? "allow" : "deny";
}
// Claude Code starts a stopped launcher again only at a call of one of its
// tools; /mcp reconnect is not available in a Desktop session. So when no
// launcher runs, the Mod passes a call to the host instead of refusing it.
// The new launcher starts disabled, and the Mod writes no caller record for
// the call, so the launcher refuses it. Nothing runs.
const RESTARTED =
  "CUA started a new launcher, because the previous launcher had stopped, for example after an interrupted call. The new launcher starts disabled and refused this call. Run /cua on, then try again.";
// The tokens of the wake calls that /cua has open. A wake call runs the code
// `undefined` with its token in a comment.
const wakeTokens = new Set<string>();
const wakeCode = (token: string) => `undefined /* cua-wake ${token} */`;
const WAKE = /^undefined \/\* cua-wake ([a-z0-9]+) \*\/$/;
function isWakeCall(code: unknown) {
  const token = typeof code === "string" ? WAKE.exec(code)?.[1] : undefined;
  return token !== undefined && wakeTokens.has(token);
}
// How long /cua waits for a launcher that it started to report its status.
const WAKE_POLLS = 20;
const WAKE_POLL_MS = 250;
// Reads launcher control for a /cua command. When no launcher runs, the Mod
// first starts one with a call of its js tool. The call passes the Mod's own
// hooks as a call without a launcher, and the new launcher refuses it.
async function controlSnapshot(
  $: EngineInterface,
  action: string,
  known: string[],
  server: string,
): Promise<Snapshot> {
  try {
    return await snapshot($, action, known);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  // The token marks the call as the Mod's own. Only such a call passes the
  // tool check without a person, and it never gets a caller record.
  const token = `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  wakeTokens.add(token);
  try {
    await $.mcp.call(server, "js", { code: wakeCode(token) });
  } catch {
    /* The new launcher refuses the call. */
  } finally {
    wakeTokens.delete(token);
  }
  for (let poll = 1; ; poll++) {
    try {
      return await snapshot($, action, known);
    } catch (error) {
      if (!isMissing(error) || poll >= WAKE_POLLS) throw error;
    }
    await $.clock.sleep(WAKE_POLL_MS);
  }
}
// Whether the /cua controls and the launcher connection serve this session
// now. The interactive terminal always has them, also while a remote client
// is attached. An SDK start has them only while Desktop is its only surface,
// so a -p run, another SDK host, and the VS Code panel never connect.
async function controlsAvailable($: EngineInterface, start: Start | undefined) {
  if (start === "terminal") return true;
  if (start !== "sdk") return false;
  return (
    (await surfaceRefusal($, start).catch(() => UNSUPPORTED)) === undefined
  );
}
// A failed connection can recover later, for example through /mcp. Ask the
// host again while the last answer was a refusal; the host connects a server
// only once, and it never connects a server that the user disabled.
async function reconnect(
  $: EngineInterface,
  start: Start | undefined,
  connected: boolean,
) {
  if (!(await controlsAvailable($, start))) return false;
  if (connected) return true;
  const result = await $.mcp.connect("cua");
  if (result.isConnected && result.server) mcpServer = result.server;
  return result.isConnected;
}
// The name under which the session runs the plugin's server, as
// $.mcp.connect reports it.
let mcpServer = "plugin:cua-integration:cua";
// No choice outlives the launcher. A lasting permission belongs in the Codex
// app (decision 0002).
const LABELS: Record<Exclude<Choice, "cancel">, string> = {
  once: "Allow",
  session: "Allow for this session",
  decline: "Deny",
};
// The browser keeps a denial of a site request for the session of the
// runtime, and an approval for the session unless a site policy limits it to
// the turn. So a site dialog has no one-time choice.
const SITE_LABELS: typeof LABELS = {
  ...LABELS,
  decline: "Deny for this session",
};
const KINDS = ["app", "origin", "history", "download", "upload"];
const HEADERS: Record<Offer["kind"], string> = {
  app: "App access",
  origin: "Site access",
  history: "History access",
  download: "File download",
  upload: "File upload",
};
function offerOf(value: unknown): Offer | undefined {
  const offer = value as Offer;
  return offer &&
    typeof offer.operationId === "string" &&
    KINDS.includes(offer.kind) &&
    typeof offer.appId === "string" &&
    typeof offer.appName === "string" &&
    typeof offer.operation === "string" &&
    typeof offer.riskLevel === "string" &&
    Array.isArray(offer.choices) &&
    (offer.detail === undefined || typeof offer.detail === "string")
    ? offer
    : undefined;
}
// What a browser request asks for, in the words of its dialog.
function browserRequestOf(offer: Offer): string {
  switch (offer.kind) {
    case "history":
      return `to read your browsing history (${offer.detail ?? "no details"})`;
    case "download":
      return `to download files from ${offer.appId}`;
    default:
      return `to upload files to ${offer.appId}. The request does not name the files`;
  }
}
// The dialog question. It states the lifetime of each offered choice, so a
// refusal of one request does not read as a lasting denial. It names the
// Codex app as the place for a lasting permission.
function questionOf(offer: Offer, choices: readonly Choice[]): string {
  if (offer.kind === "origin")
    return [
      `Browser use in "${offer.appName}" requests access to the site ${offer.appId}. Allow it?`,
      `The browser keeps a denial until the CUA runtime stops, and usually keeps an approval as long. Set lasting site permissions in the Codex app.`,
    ].join(" ");
  if (offer.kind !== "app")
    return [
      `Browser use in "${offer.appName}" requests ${browserRequestOf(offer)}. Allow it?`,
      `"Allow" and "Deny" answer this request only.`,
      ...(choices.includes("session")
        ? [
            `"Allow for this session" lasts until the CUA runtime stops, for this origin.`,
          ]
        : []),
      `Set lasting browser permissions in the Codex app.`,
    ].join(" ");
  return [
    `Computer Use requests ${offer.operation} (${offer.riskLevel} risk) on "${offer.appName}" (${offer.appId}). Allow it?`,
    `"Allow" and "Deny" answer this request only.`,
    ...(choices.includes("session")
      ? [`"Allow for this session" lasts until the CUA launcher stops.`]
      : []),
    `Set lasting app permissions in the Codex app.`,
  ].join(" ");
}
const LASTING =
  "Lasting app and site permissions belong in the Codex app, for example on its Computer Use always-allow list. This integration keeps no lasting permission and cannot end one.";
function grantText(list: GrantList): string {
  const legacy = list.legacyStore;
  return [
    list.launcherConnected
      ? `Session grants of this launcher: ${list.session.length === 0 ? "none" : list.session.map((grant) => `${grant.appName} (${grant.resource})`).join(", ")}. Each ends when the CUA launcher stops, for example at a /mcp reconnect or at Claude Code exit.`
      : "Session grants: none, because the CUA launcher is disconnected.",
    LASTING,
    ...(legacy
      ? [
          `An earlier version kept grants in ${legacy.path}. This version does not read that file, so its grants no longer apply${legacy.apps?.length ? `: ${legacy.apps.join(", ")}` : ""}. To use an app without a dialog, add it to the always-allow list in the Codex app. You can then delete the file.`,
        ]
      : []),
  ].join("\n");
}
// The host raises a tool.check of AskUserQuestion for each $.ui.ask before
// the dialog shows, and the Mod's own tool.check hook receives it. Its
// `approver` is the engine's word on who answers: `person` for a dialog that a
// person answers, `host` for a host program, and absent where nobody can.
// The check carries the question, the header, and the labels of the dialog
// in its input, so the Mod gives each check to its own dialog: the first open
// dialog with the same text that has no check yet. The engine cuts the header
// to 12 characters (2.1.311 sent "History acce" for "History access"), so a
// header matches when it starts the header of the dialog. Dialogs with the same text
// take one check each. A check that matches no open dialog, such as one for a
// question of the model, belongs to no dialog of the Mod.
type OpenDialog = {
  question: string;
  header: string;
  labels: readonly string[];
  approvers: Array<string | undefined>;
};
const openDialogs: OpenDialog[] = [];
function attributeCheck(input: unknown, approver: string | undefined) {
  const asked = (
    input as
      | {
          questions?: Array<{
            question?: unknown;
            header?: unknown;
            options?: Array<{ label?: unknown }>;
          }>;
        }
      | undefined
  )?.questions?.[0];
  if (!asked || !Array.isArray(asked.options)) return;
  const labels = asked.options.map((option) => option?.label);
  const matches = openDialogs.filter(
    (dialog) =>
      dialog.question === asked.question &&
      typeof asked.header === "string" &&
      dialog.header.startsWith(asked.header) &&
      dialog.labels.length === labels.length &&
      dialog.labels.every((label, i) => label === labels[i]),
  );
  const target =
    matches.find((dialog) => dialog.approvers.length === 0) ?? matches[0];
  target?.approvers.push(approver);
}
// Who answered one dialog, for the record of launcher control: `person` when
// each check reported a person, `host` when a check reported the host, and
// `none` when no dialog opened or no check named anyone.
type Approver = "person" | "host" | "none";
type Answer = { choice: Choice; reason?: string; approver: Approver };
function approverOf(approvers: ReadonlyArray<string | undefined>): Approver {
  if (approvers.length > 0 && approvers.every((a) => a === "person"))
    return "person";
  return approvers.includes("host") ? "host" : "none";
}
// Asks in the host's own question dialog. A Mod reaches that dialog only
// through $.ui.ask: the host refuses a Mod's direct AskUserQuestion call. Only
// a label that the user picked answers. Any other text, such as text typed
// under "Other", is not a permitted choice, so it declines. A dialog that
// closes without an answer cancels and carries the reason, so the user learns
// why no approval took effect. An answer that grants access applies only when
// the host reported that a person answers the dialog. A decline always
// applies.
async function ask($: EngineInterface, offer: Offer): Promise<Answer> {
  const choices = (["once", "session", "decline"] as const).filter((choice) =>
    offer.choices.includes(choice),
  );
  const labels = offer.kind === "origin" ? SITE_LABELS : LABELS;
  const dialog: OpenDialog = {
    question: questionOf(offer, choices),
    header: HEADERS[offer.kind],
    labels: choices.map((choice) => labels[choice]),
    approvers: [],
  };
  const { approvers } = dialog;
  openDialogs.push(dialog);
  try {
    const label = await $.ui.ask(dialog.question, {
      options: dialog.labels,
      header: dialog.header,
    });
    const choice =
      choices.find((choice) => labels[choice] === label) ?? "decline";
    const approver = approverOf(approvers);
    if (choice !== "decline" && approver !== "person")
      return {
        choice: "cancel",
        reason:
          "the host did not report that a person answers this dialog, so the Mod sent cancel instead of the answer",
        approver,
      };
    return { choice, approver };
  } catch (error) {
    return {
      choice: "cancel",
      reason: `the dialog closed without an answer (${error instanceof Error ? error.message : String(error)})`,
      approver: approverOf(approvers),
    };
  } finally {
    openDialogs.splice(openDialogs.indexOf(dialog), 1);
  }
}
// The operations that a watcher in this process already asked about. Calls can
// overlap, and every watcher reads the same offers, so the first watcher that
// claims an operation is its only presenter. Operation IDs are UUIDs that the
// launcher never reuses.
const claimed = new Set<string>();
// Presents one offer: a dialog, or a cancel without one. Resolves undefined
// when the call ended before the dialog could open, because its request then
// ended too.
async function present(
  $: EngineInterface,
  offer: Offer,
  start: Start | undefined,
  stopped: () => boolean,
): Promise<Answer | undefined> {
  // A remote client can attach while a call runs. Its dialog then gets no
  // presentation, and the request is cancelled.
  if ((await surfaceRefusal($, start).catch(() => UNSUPPORTED)) !== undefined)
    return {
      choice: "cancel",
      reason:
        "a remote client is attached to this session, or no supported surface draws it, so the Mod showed no dialog",
      approver: "none",
    };
  // The call can end while the surface query runs.
  if (stopped()) return undefined;
  const answer = await ask($, offer);
  // A remote client can also attach while the dialog is open. An answer
  // that grants access then does not apply.
  if (
    answer.choice !== "decline" &&
    answer.choice !== "cancel" &&
    (await surfaceRefusal($, start).catch(() => UNSUPPORTED)) !== undefined
  )
    return {
      choice: "cancel",
      reason:
        "a remote client attached while the dialog was open, so the Mod sent cancel instead of the answer",
      approver: answer.approver,
    };
  return answer;
}
// While a call runs, the launcher can hold approval requests that the runtime
// sent for it. Poll launcher control, ask once for each offered request, and
// return the answer to the launcher that offered it. stop() ends polling, and
// no new dialog opens after it. A dialog that is already open still sends its
// answer, and the launcher refuses an answer for a request that ended. notes
// holds the reason for each cancel.
function watchApprovals(
  $: EngineInterface,
  known: string[],
  start: Start | undefined,
): { stop(): void; notes: string[] } {
  let stopped = false;
  const notes: string[] = [];
  void (async () => {
    while (!stopped) {
      let found: { value: unknown; session: string } | undefined;
      try {
        found = await lookup($, ["approvals"], known);
      } catch {
        /* The next poll retries; the approval timeout bounds the wait. */
      }
      const list = (found?.value as { approvals?: unknown } | undefined)
        ?.approvals;
      for (const value of Array.isArray(list) ? list : []) {
        // The call can end while launcher control runs or a dialog is open.
        if (stopped) break;
        const offer = offerOf(value);
        const operationId = (value as { operationId?: unknown } | null)
          ?.operationId;
        // An offer that the Mod cannot present gets no dialog. It is
        // cancelled at once, so it does not wait as a pending approval that
        // nobody sees.
        if (!offer && typeof operationId === "string") {
          if (claimed.has(operationId)) continue;
          claimed.add(operationId);
          const note = `CUA could not show approval request ${operationId}, because the Mod does not recognize its form. The request was cancelled, and no approval dialog is open for it.`;
          notes.push(note);
          $.ui.toast(note, { timeoutMs: 10000 });
          try {
            await controlRun(
              $,
              ["answer", operationId, "cancel", "none"],
              [found!.session],
            );
          } catch {
            /* The approval timeout cancels the request. */
          }
          continue;
        }
        if (!offer || claimed.has(offer.operationId)) continue;
        claimed.add(offer.operationId);
        const answer = await present($, offer, start, () => stopped);
        if (!answer) break;
        const { choice, reason, approver } = answer;
        if (reason) {
          const note = `CUA approval for ${offer.appName} was cancelled: ${reason}`;
          notes.push(note);
          $.ui.toast(note, { timeoutMs: 10000 });
        }
        try {
          await controlRun(
            $,
            ["answer", offer.operationId, choice, approver],
            [found!.session],
          );
        } catch (error) {
          $.ui.toast(
            `CUA approval for ${offer.appName} was not applied: ${error instanceof Error ? error.message : "launcher control failed"}`,
          );
        }
      }
      await $.clock.sleep(APPROVAL_POLL_MS);
    }
  })().catch(() => {
    /* An approval left unanswered expires and cancels. */
  });
  return {
    stop() {
      stopped = true;
    },
    notes,
  };
}
export const register: Register = (on) => {
  // The host replaces hooks on reload. Command registration replaces the
  // same name, and MCP connection reuses the host owner.
  // How the session started, or undefined for a start outside both profiles.
  let start: Start | undefined;
  // Whether the start hook completed. A failed start hook leaves the controls
  // and the launcher connection off, so every call is refused as disabled.
  let ready = false;
  let connected = false;
  // The session IDs under which a launcher can be registered, most recent
  // first. The array stays the same object, so running watchers see updates.
  const known: string[] = [];
  // The current turn of each loop, from turn.start. A reload empties the map,
  // so a call before the next turn.start carries no turn, never a stale one.
  const turns = new Map<string, string>();
  // The turns, by loop and turn ID, that sent a call to the launcher. Only
  // these turns need a turn end there.
  const reported = new Set<string>();
  const turnKey = (turnId: string, agentId?: string) =>
    JSON.stringify([agentId ?? null, turnId]);
  on("session.start", async ($, event, next) => {
    start =
      event.surface === "terminal" && event.isInteractive
        ? "terminal"
        : event.surface === null && !event.isInteractive
          ? "sdk"
          : undefined;
    ready = false;
    connected = false;
    // A fresh load has no held value. A reload keeps the known sessions. A
    // failure to read or write them never disables the interactive controls.
    known.splice(0, known.length, ...(await heldSessions($)));
    if (known.length === 0) await remember($, known, await $.session.id());
    await $.command.register({
      name: "cua",
      description: "CUA controls and launcher status",
      argumentHint: "[on|off|status|grants]",
      immediate: true,
    });
    ready = true;
    // Desktop attaches after session start, so its session connects at the
    // first command or call instead.
    connected = await reconnect($, start, connected);
    if (connected) await display($, await snapshot($, "status", known));
    return next(event);
  }).catch((_host, event) => {
    ready = false;
    connected = false;
    return { cwd: event.cwd };
  });
  // Desktop attaches its client after session start. The Mod then connects
  // and shows the status line, as it does at the start of a terminal session.
  // A failure leaves the connection to the first command or call.
  on("session.attach", async ($, event, next) => {
    if (ready && start === "sdk" && event.surface === "desktop")
      try {
        connected = await reconnect($, start, connected);
        if (connected) await display($, await snapshot($, "status", known));
      } catch {
        /* The next command or call connects again. */
      }
    return next(event);
  });
  on(
    "command.run",
    { command: ["cua", "cua-integration:cua"] },
    async ($, event) => {
      if (!ready || !(await controlsAvailable($, start)))
        return {
          text: "CUA controls require the interactive terminal CLI or Claude Code Desktop, with no other client attached to a Desktop session. VS Code, remote, and headless operation are unsupported.",
        };
      const [action = "status", ...rest] = event.args
        .split(/\s+/)
        .filter(Boolean);
      // The report reads no launcher state except the session grants, so it
      // works while the launcher is disconnected.
      if (action === "grants" && rest.length === 0)
        try {
          return { text: grantText(await grantList($, known)) };
        } catch (error) {
          return {
            text: `CUA grant listing failed: ${(error instanceof Error ? error.message : "launcher control failed").replace(/\.$/, "")}. Use /cua status to check the launcher.`,
          };
        }
      if (action === "revoke")
        return {
          text: `/cua revoke is no longer available, because this integration keeps no lasting grant. A session grant ends when the CUA launcher stops. ${LASTING}`,
        };
      if (!["on", "off", "status"].includes(action) || rest.length > 0)
        return {
          text: "Usage: /cua [on|off|status|grants]",
        };
      connected = await reconnect($, start, connected);
      if (!connected)
        return {
          text: "CUA launcher is disconnected. Reconnect the plugin MCP server before use.",
        };
      const value = await controlSnapshot($, action, known, mcpServer);
      if (action !== "status")
        await $.store.set("lastEnabledPreference", action === "on");
      await display($, value);
      const tools = await $.tool.list();
      return {
        text: text(
          value,
          TOOLS.every((name) => tools.some((tool) => tool.name === name)),
        ),
      };
    },
  ).catch(() => ({
    text: "CUA control failed. Execution remains subject to the launcher gate. Reconnect the plugin and inspect /mcp.",
  }));
  on("tool.check", { tool: [...TOOLS, ASK_TOOL] }, async ($, event, next) => {
    // The check of a question dialog only records who answers it, and the
    // host's verdict stands. See ask().
    if (event.tool === ASK_TOOL) {
      attributeCheck(event.input, event.approver);
      return next(event);
    }
    const refusal = await surfaceRefusal($, start);
    if (refusal) return { decision: "deny", reason: refusal };
    // Without a person, no approval dialog can be answered. An app that the
    // Codex app always allows needs no dialog, so this check comes first.
    // Only a wake call of /cua passes without a person: it never gets a
    // caller record, so no launcher runs it.
    const waking = isWakeCall((event.input as { code?: unknown } | null)?.code);
    if (event.approver !== "person" && !waking)
      return { decision: "deny", reason: NO_PERSON };
    connected = await reconnect($, ready ? start : undefined, connected);
    const state = await gate($, connected, known);
    // No launcher runs, so the host starts one, and that launcher refuses
    // the call, which has no caller record.
    if (state === "missing") return next(event);
    if (state === "deny") return { decision: "deny", reason: DENIED };
    // A query never changes grants or replaces the host's own permission check.
    return next(event);
  }).catch(() => ({ decision: "deny", reason: DENIED }));
  on("tool.call", { tool: TOOLS }, async ($, event, next) => {
    const refusal = await surfaceRefusal($, start);
    if (refusal) return { deny: refusal };
    connected = await reconnect($, ready ? start : undefined, connected);
    const state = await gate($, connected, known);
    if (state === "deny") return { deny: DENIED };
    // A wake call of /cua never gets a caller record, so a launcher refuses
    // it, also one that started meanwhile.
    if (isWakeCall((event as { code?: unknown }).code)) return next(event);
    // No launcher runs. The host starts one at this call. The Mod writes no
    // caller record, so the new launcher refuses the call. See RESTARTED.
    if (state === "missing") {
      const result = await next(event);
      try {
        await display($, await snapshot($, "status", known));
      } catch {
        /* The next command shows the new launcher. */
      }
      return result && typeof result === "object" && result.deny === undefined
        ? { ...result, context: [...(result.context ?? []), RESTARTED] }
        : result;
    }
    // The launcher reads this record when the call arrives, so the runtime
    // sees the real turn and agent. The launcher refuses a call without a
    // record, because it cannot tell which caller's runtime may run it. After
    // a reload no turn is known until the next turn.start, so the tool-use ID
    // stands in for the turn, and no turn end can name the call.
    const turnId = turns.get(event.agentId ?? MAIN_LOOP);
    if (event.tool_use_id)
      try {
        await lookup(
          $,
          [
            "call",
            event.tool_use_id,
            turnId ?? event.tool_use_id,
            await $.session.id(),
            ...(event.agentId === undefined ? [] : [event.agentId]),
          ],
          known,
        );
        if (turnId !== undefined) reported.add(turnKey(turnId, event.agentId));
      } catch {
        /* The launcher refuses the unrecorded call. */
      }
    // Preserve reserved tool/caller fields and the original MCP result mapper.
    const approvals = watchApprovals($, known, start);
    let result;
    try {
      result = await next(event);
    } finally {
      approvals.stop();
    }
    // The runtime reports only that access was not approved. The model also
    // needs to know when no person answered, so it does not treat a failed
    // dialog as a refusal. A deny carries no context.
    if (
      approvals.notes.length > 0 &&
      result &&
      typeof result === "object" &&
      result.deny === undefined
    )
      result = {
        ...result,
        context: [...(result.context ?? []), ...approvals.notes],
      };
    try {
      await display($, await snapshot($, "status", known));
    } catch {
      /* The result still belongs to the native MCP mapper. */
    }
    return result;
  }).catch((_host, _event, next) => {
    if (!next.called) return { deny: DENIED };
    const message = `CUA execution failed: ${next.error.message ?? "host handler failed"}. External effects may already have occurred. Inspect current state before any retry.`;
    return { isError: true, text: message, result: message };
  });
  // No prompt.compose hook: tool discovery and enforcement survive hosts that
  // do not permit user prompt composition. Other tools keep their host policy.
  on("turn.start", (_host, event, next) => {
    turns.set(event.agentId ?? MAIN_LOOP, event.turnId);
    return next(event);
  });
  // The launcher delivers the turn end to the runtime that ran the turn's
  // calls. The Mod only queues the event; the launcher reports the outcome in
  // its status, separately from this dispatch.
  on("turn.complete", async ($, event, next) => {
    const loop = event.agentId ?? MAIN_LOOP;
    if (turns.get(loop) === event.turnId) turns.delete(loop);
    const key = turnKey(event.turnId, event.agentId);
    if (reported.delete(key))
      try {
        await lookup(
          $,
          [
            "turn-end",
            event.turnId,
            event.isAborted ? "aborted" : "answer",
            ...(event.agentId === undefined ? [] : [event.agentId]),
          ],
          known,
        );
      } catch {
        /* The runtime keeps its turn state; the turn end is not confirmed. */
      }
    return next(event);
  });
  // On /clear or /resume the process continues under a new session ID and no
  // session.start follows, so the surface and launcher connection stay valid.
  // The launcher must still drop what the old conversation created. The Mod
  // queues that transition when the shared session-end bound leaves time.
  // Otherwise the launcher detects the new conversation at its next call.
  on("session.end", async ($, event, next) => {
    turns.clear();
    reported.clear();
    if (event.reason !== "clear" && event.reason !== "resume") {
      ready = false;
      connected = false;
      known.length = 0;
    } else if (connected && next.budget.remainingMs > SESSION_END_RESERVE_MS)
      try {
        await lookup($, ["session-end", event.reason, event.sessionId], known);
      } catch {
        /* The launcher detects the new conversation at its next call. */
      }
    return next(event);
  });
};
