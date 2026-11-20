// The native check of `/cua check`: one observation of a document that the
// launcher itself created. The check proves two capabilities of the Computer
// Use service on this Mac. The accessibility text of the observation must
// contain a random marker, and the observation must carry an image that
// passes the image validator. The marker is in the document only. It is never
// a request argument, and the file name does not contain it, so a reply that
// repeats the request cannot pass.
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolResult } from "../contracts.ts";
import type { FailureCategory as NativeCategory } from "../native/sky-guard.ts";
import { inspectImages } from "../observations/result.ts";

// The one app that the check observes.
export const CHECK_APP = "com.apple.TextEdit";
// How long the script of the check may run. The time that a person takes for
// the approval dialogs can count against it.
export const CHECK_TIMEOUT_MS = 600000;
// How long TextEdit gets to show the document before the observation.
export const OPEN_SETTLE_MS = 2000;
// The script writes one line with this prefix: its own report of each step.
const REPORT_PREFIX = "cua-check-report ";

// The version of one runtime: the runtime plugin and each package, as the
// launch diagnostics report them.
export type RuntimeVersion = {
  pluginVersion: string;
  packages: Record<string, string>;
};
export function sameRuntime(
  a: RuntimeVersion | undefined,
  b: RuntimeVersion | undefined,
): boolean {
  if (!a || !b || a.pluginVersion !== b.pluginVersion) return false;
  const names = Object.keys(a.packages);
  return (
    names.length === Object.keys(b.packages).length &&
    names.every((name) => a.packages[name] === b.packages[name])
  );
}

// The result for one capability. `failure` is the category of the native
// guard, when the failure text carried one. `reason` says in one sentence why
// the capability is not verified.
export type Capability =
  | { state: "verified" }
  | { state: "unverified"; failure?: NativeCategory; reason?: string };
// What became of the document of the check.
//   `not-opened`  the check ended before it created the document
//   `closed`      a later observation no longer showed the window
//   `left-open`   the window can still be open; the file is gone
export type CheckWindow = "not-opened" | "closed" | "left-open";
// The result of one finished check. It holds no accessibility text and no
// image.
export type CheckResult = {
  id: string;
  app: typeof CHECK_APP;
  // When the check ended.
  at: string;
  // The runtime that the check ran in. Absent when the runtime did not start.
  runtime?: RuntimeVersion;
  accessibility: Capability;
  screenCapture: Capability;
  // How many approval requests of the check reached the launcher: the ones
  // that opened a dialog, and the ones that a session grant answered. With 0
  // requests, the Codex app allowed TextEdit without a request.
  approvals: { dialogs: number; sessionGrant: number };
  // The file name of the document, which is also its window title.
  document?: string;
  window: CheckWindow;
  // False when the file of the document is still on disk.
  fileRemoved: boolean;
};
// What the status reports as the native permission of the current runtime.
export type NativePermission = {
  accessibility: Capability;
  screenCapture: Capability;
  // The last check of this launcher, when its runtime is the current one.
  check?: CheckResult;
  // The last check of this launcher, when it ran with another runtime
  // version. Its result does not apply to the current runtime.
  otherRuntime?: CheckResult;
};
export const UNVERIFIED: NativePermission = Object.freeze({
  accessibility: Object.freeze({ state: "unverified" as const }),
  screenCapture: Object.freeze({ state: "unverified" as const }),
});
const OTHER_RUNTIME =
  "The last check ran with another runtime version, so its result does not apply.";
// The native permission of the runtime `current`, from the last check of the
// launcher. A result of another runtime version never shows as current.
export function nativePermission(
  result: CheckResult | undefined,
  current: RuntimeVersion | undefined,
): NativePermission {
  if (!result) return UNVERIFIED;
  // A check that ended before its runtime started verified nothing, for any
  // runtime. It shows as the last check, with its reason.
  if (!result.runtime) {
    const unproven = (capability: Capability): Capability =>
      capability.state === "verified"
        ? { state: "unverified", reason: "The check recorded no runtime." }
        : capability;
    return {
      accessibility: unproven(result.accessibility),
      screenCapture: unproven(result.screenCapture),
      check: result,
    };
  }
  if (!sameRuntime(result.runtime, current))
    return {
      accessibility: { state: "unverified", reason: OTHER_RUNTIME },
      screenCapture: { state: "unverified", reason: OTHER_RUNTIME },
      otherRuntime: result,
    };
  return {
    accessibility: result.accessibility,
    screenCapture: result.screenCapture,
    check: result,
  };
}

const CATEGORIES = [
  "refused",
  "ownership",
  "approval",
  "policy",
  "identity",
  "sender",
  "permission",
  "session",
  "interruption",
  "intervention",
  "accessibility",
  "protocol",
  "transport",
  "observation",
  "unknown",
] as const satisfies readonly NativeCategory[];
const BRACKET = new RegExp(`\\[(${CATEGORIES.join("|")})(?:: [A-Za-z]+)?\\]`);
// The category that the native guard put in a failure text. A guard rule has
// no bracket: its text starts with "Computer Use refused:".
export function guardCategory(text: string): NativeCategory | undefined {
  const bracket = BRACKET.exec(text)?.[1];
  if (bracket) return bracket as NativeCategory;
  if (!/\bComputer Use refused: /.test(text)) return undefined;
  return /computer lease/.test(text) ? "ownership" : "refused";
}

// The element index of the control that closes the document `name`, from
// the accessibility text of an observation of its window, or null when the
// text shows no such control. TextEdit can show a document as a tab of a
// window with other documents. The close button of that window closes each
// tab, so the function then takes the "Close tab" button that follows the tab
// of the document. It takes the close button of the window only when the
// window has no tab bar. The check script holds the text of this function,
// so it has no reference to another name of this module.
export function closeTarget(state: string, name: string): number | null {
  const lines = state.split("\n");
  const index = (line: string | undefined, role: RegExp) => {
    const match = (line ?? "").match(role);
    return match ? Number(match[1]) : null;
  };
  const tab = lines.findIndex(
    (line) => /^\s*\d+ tab /.test(line) && line.includes(name),
  );
  if (tab >= 0) return index(lines[tab + 1], /^\s*(\d+) button Close tab\b/);
  if (lines.some((line) => /^\s*\d+ tab (group|bar)\b/.test(line))) return null;
  for (const line of lines) {
    const found = index(line, /^\s*(\d+) close button\s*$/);
    if (found !== null) return found;
  }
  return null;
}

export function newMarker(): string {
  return `cuamarker${randomBytes(16).toString("hex")}`;
}
// The file name of the document, which TextEdit shows as the window title.
// It is random and has no relation to the marker.
export function documentName(): string {
  return `cua-check-${randomBytes(4).toString("hex")}.txt`;
}

// The way to remove the file of one check document.
export type CheckDocument = {
  // Deletes the file and its directory. Resolves false when a file is left.
  remove(): boolean;
};
// Creates the document `name` with the marker as its content and opens it in
// TextEdit. The launcher calls it while the runtime of the check holds the
// lease of the controlled resource.
export type CheckEnvironment = {
  open(name: string, marker: string): Promise<CheckDocument>;
};
// Opens one file in TextEdit and waits until TextEdit can show it.
async function showInTextEdit(path: string): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    execFile(
      "/usr/bin/open",
      ["-b", CHECK_APP, path],
      { timeout: 30000 },
      (error) => (error ? reject(error) : resolve()),
    ),
  );
  await new Promise((resolve) => setTimeout(resolve, OPEN_SETTLE_MS));
}
// A temporary plain-text file in a directory of its own, which `show` opens.
// The default opens it in TextEdit with /usr/bin/open, and uses no
// AppleScript.
export function documentEnvironment(
  show: (path: string) => Promise<void> = showInTextEdit,
  parent = tmpdir(),
): CheckEnvironment {
  return {
    async open(name, marker) {
      const directory = mkdtempSync(join(parent, "cua-check-"));
      const document: CheckDocument = {
        remove() {
          rmSync(directory, { recursive: true, force: true });
          return !existsSync(directory);
        },
      };
      try {
        writeFileSync(join(directory, name), `${marker}\n`, { mode: 0o600 });
        await show(join(directory, name));
      } catch (error) {
        document.remove();
        throw error;
      }
      return document;
    },
  };
}

// The script of the check. The launcher writes it, and no model code runs in
// the runtime of the check. It names the document by its file name only.
//
// Each native step needs its own approval: bind, observe, close, and confirm.
// The one observation of the check is `getAXStateAndScreenshot`, which writes
// the accessibility text and emits the image. The script never throws,
// because the runtime drops an emitted image from an error result. It closes
// the window only when the observation showed the window of the check first,
// and it reads the state after the close without output.
//
// The close is a click on a control of the document window by its element
// index from that observation. An approval can wait between the observation
// and the click, and another TextEdit document can come to the front in that
// time. A key press goes to the front window, so the script uses none: the
// element index names a control of the observed window only. When the
// observation shows no such control, the window stays open and the result
// says so.
export function checkScript(documentName: string): string {
  const title = JSON.stringify(`Window: "${documentName}"`);
  const name = JSON.stringify(documentName);
  return [
    `const closeTarget = ${closeTarget.toString()};`,
    `const report = { bound: false, observed: false, window: false, closed: null, errors: [] };`,
    `const note = (stage, error) => report.errors.push({ stage, message: String(error && error.message !== undefined ? error.message : error).slice(0, 600) });`,
    `let app;`,
    `try { app = await cua.getApp(${JSON.stringify(CHECK_APP)}); report.bound = true; } catch (error) { note("bind", error); }`,
    `if (app) {`,
    `  let state = "";`,
    `  try { const seen = await app.getAXStateAndScreenshot({ disableDiffing: true }); state = typeof seen === "string" ? seen : String((seen && seen.state) ?? ""); report.observed = true; } catch (error) { note("observe", error); }`,
    `  report.window = state.startsWith(${title});`,
    `  const target = report.window ? closeTarget(state, ${name}) : null;`,
    `  if (target !== null) {`,
    `    try { await app.click(target); const after = await app.getAXState({ emit: false, disableDiffing: true }); report.closed = !String(after).includes(${name}); } catch (error) { note("close", error); report.closed = false; }`,
    `  } else if (report.window) report.closed = false;`,
    `}`,
    `nodeRepl.write("\\n${REPORT_PREFIX}" + JSON.stringify(report));`,
  ].join("\n");
}

type ScriptReport = {
  bound: boolean;
  observed: boolean;
  window: boolean;
  closed: boolean | null;
  errors: Array<{ stage: string; message: string }>;
};
function scriptReport(text: string): ScriptReport | undefined {
  const start = text.lastIndexOf(REPORT_PREFIX);
  if (start < 0) return undefined;
  try {
    const value = JSON.parse(
      text.slice(start + REPORT_PREFIX.length).split("\n")[0]!,
    );
    if (
      typeof value?.bound !== "boolean" ||
      typeof value.observed !== "boolean" ||
      typeof value.window !== "boolean" ||
      !Array.isArray(value.errors)
    )
      return undefined;
    return {
      bound: value.bound,
      observed: value.observed,
      window: value.window,
      closed: typeof value.closed === "boolean" ? value.closed : null,
      errors: value.errors.filter(
        (entry: any) =>
          typeof entry?.stage === "string" && typeof entry.message === "string",
      ),
    };
  } catch {
    return undefined;
  }
}
// One line of at most 300 characters, with "~" for the home directory.
const sentence = (text: string) =>
  (homedir() !== "/" ? text.split(homedir()).join("~") : text)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);

// Judges the result of the check script. The verdict rests on the marker and
// on the image only. The report of the script explains a failure and tells
// whether the window closed. It cannot make a capability verified.
export function evaluate(
  result: ToolResult,
  marker: string,
  refused: boolean,
): {
  accessibility: Capability;
  screenCapture: Capability;
  closed: boolean;
} {
  const text = result.content
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("\n");
  const report = scriptReport(text);
  // A refused, dismissed, or expired approval at any step ends the check
  // with no verified result, also when the marker and the image arrived
  // before it (issue #59). The launcher knows an answer of the person, and
  // the report of the script holds the refusal that the runtime returned.
  const refusedStep = report?.errors.find(
    (entry) => guardCategory(entry.message) === "approval",
  );
  if (refused || refusedStep) {
    const capability: Capability = {
      state: "unverified",
      failure: "approval",
      reason: sentence(
        refusedStep
          ? `An approval of the check was refused at the step "${refusedStep.stage}": ${refusedStep.message}`
          : "An approval of the check was refused or dismissed, so the check verified nothing.",
      ),
    };
    return {
      accessibility: capability,
      screenCapture: capability,
      closed: report?.closed === true,
    };
  }
  // The first failure before or in the observation explains both
  // capabilities. A failure of the close step explains neither.
  const failed = report?.errors.find((entry) => entry.stage !== "close");
  const category = guardCategory(failed?.message ?? (report ? "" : text));
  const failure = (fallback: string): Capability => ({
    state: "unverified",
    ...(category
      ? { failure: category }
      : refused
        ? { failure: "approval" }
        : {}),
    reason: sentence(
      failed
        ? `The ${failed.stage === "bind" ? "request for TextEdit" : "observation"} failed: ${failed.message}`
        : fallback,
    ),
  });
  let images = 0;
  let imageFault: string | undefined;
  try {
    images = inspectImages(result).length;
  } catch (error) {
    imageFault = error instanceof Error ? error.message : String(error);
  }
  return {
    accessibility: text.includes(marker)
      ? { state: "verified" }
      : failure(
          report?.observed && !report.window
            ? "The observation showed another window, not the document of the check."
            : "The accessibility text of the observation did not contain the marker of the document.",
        ),
    screenCapture:
      images > 0
        ? { state: "verified" }
        : failure(
            imageFault
              ? `The image of the observation did not pass the validator: ${imageFault}`
              : "The observation carried no image.",
          ),
    closed: report?.closed === true,
  };
}
// The result for both capabilities when the check ended without a result of
// its script, for example a refused start, a lease that did not arrive, or a
// stopped runtime.
export function failed(error: unknown): Capability {
  const message = error instanceof Error ? error.message : String(error);
  const category = guardCategory(message);
  return {
    state: "unverified",
    ...(category ? { failure: category } : {}),
    reason: sentence(`The check did not complete: ${message}`),
  };
}
