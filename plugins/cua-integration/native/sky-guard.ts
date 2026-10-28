// The trusted `sky` service handler. The launcher configures this module in
// place of the provider handler, and the runtime's trusted worker loads it.
// Model JavaScript cannot reach the native pipe itself, so every native request
// passes here: the cua facade, a direct `@oai/sky` import, and a raw
// `nodeRepl.rpc("sky", ...)` call alike.
//
// The worker accepts only files under a configured trusted code path and loads
// this file with type stripping. Keep it self-contained, with Node imports only.
import { lstatSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";

export type SkyService = (request: unknown) => Promise<unknown>;
// Reports the epoch of the lease that this runtime holds, or throws when it
// holds none. The epoch changes each time the lease passes to another
// runtime connection.
export type OwnerCheck = () => string;

// These categories name the origin of a failure, not its severity.
export type FailureCategory =
  | "refused"
  | "ownership"
  | "approval"
  | "policy"
  | "identity"
  | "sender"
  | "permission"
  | "session"
  | "interruption"
  | "accessibility"
  | "protocol"
  | "transport"
  | "observation"
  | "unknown";

// The reviewed macOS client methods. Every other method fails closed.
const OBSERVATIONS = new Set(["list_apps", "get_app_state"]);
const INPUTS = new Set([
  "click",
  "drag",
  "scroll",
  "press_key",
  "type_text",
  "paste",
  "set_value",
  "select_text",
  "perform_secondary_action",
]);
const INDEXED = new Set([
  "click",
  "scroll",
  "set_value",
  "select_text",
  "perform_secondary_action",
]);

// Native codes from the reviewed Sky client, grouped by origin.
const NATIVE_CATEGORIES: Readonly<Record<string, FailureCategory>> = {
  invalidApp: "identity",
  ambiguousApp: "identity",
  runningApplicationNotFound: "identity",
  senderProcessNotAuthenticated: "sender",
  couldNotGetSenderPID: "sender",
  couldNotGetBootstrapPort: "sender",
  appNotAllowed: "permission",
  permissionsNotGranted: "permission",
  permissionsPending: "permission",
  blockedURL: "permission",
  noActiveSession: "session",
  screenLocked: "session",
  userStoppedSession: "interruption",
  userIntervened: "interruption",
  accessibilityError: "accessibility",
  incompatibleClientVersion: "protocol",
  couldNotGetRequestData: "protocol",
  couldNotGetRequestTypeName: "protocol",
  couldNotResolveRequestType: "protocol",
  unhandledEvent: "protocol",
};

export const COORDINATE_REFUSAL =
  "coordinate input has no verified mapping from a screenshot to native input coordinates in this integration. Use an element index from a current accessibility observation.";

export class NativeGuardError extends Error {
  readonly category: FailureCategory;
  readonly code: string | undefined;
  constructor(
    category: FailureCategory,
    message: string,
    code?: string,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "NativeGuardError";
    this.category = category;
    this.code = code;
  }
}

const refuse = (message: string): never => {
  throw new NativeGuardError("refused", `Computer Use refused: ${message}`);
};
const plain = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;

export function classify(error: unknown): {
  category: FailureCategory;
  code?: string;
} {
  if (error instanceof NativeGuardError)
    return error.code === undefined
      ? { category: error.category }
      : { category: error.category, code: error.code };
  if (!(error instanceof Error)) return { category: "unknown" };
  if (error.name === "SkyComputerUseTransportError")
    return { category: "transport" };
  const code = (error as { errorName?: unknown }).errorName;
  if (error.name === "SkyComputerUseError" && typeof code === "string")
    return { category: NATIVE_CATEGORIES[code] ?? "unknown", code };
  // The native policy wrapper throws these before its operation callback runs.
  if (/^Computer Use was not approved to use /.test(error.message))
    return { category: "approval" };
  if (
    /^Computer Use is (blocked from using|not allowed to use) the app /.test(
      error.message,
    )
  )
    return { category: "policy" };
  return { category: "unknown" };
}

// The policy wrapper refuses before the native callback, so these categories
// establish that the input had no effect. Every other failure leaves it unknown.
const NO_EFFECT = new Set<FailureCategory>(["approval", "policy"]);

// The launcher names the lease file and this runtime's connection in the
// environment. The values match implementation/connection/ownership.ts, which
// this self-contained file cannot import.
const OWNERSHIP_ENV = "CLAUDE_CUA_OWNERSHIP";
const CONNECTION_ENV = "CLAUDE_CUA_CONNECTION";
const NOT_OWNER =
  "this runtime does not hold the computer lease. Another Claude Code session or agent controls the computer, or the call that held the lease ended.";

// Reads the lease file on each native request. A missing, unsafe, or
// unreadable file refuses, so no runtime acts while ownership is unknown.
export function leaseOwner(
  env: Record<string, string | undefined> = process.env,
): OwnerCheck {
  return () => {
    const path = env[OWNERSHIP_ENV];
    const connection = env[CONNECTION_ENV];
    if (!path || !connection)
      throw new NativeGuardError(
        "ownership",
        "Computer Use refused: the launcher assigned no computer lease to this runtime.",
      );
    let record: any;
    try {
      const stat = lstatSync(path);
      if (
        !stat.isFile() ||
        stat.uid !== process.getuid?.() ||
        (stat.mode & 0o077) !== 0
      )
        throw new Error("unsafe lease file");
      record = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      record = undefined;
    }
    if (
      record?.holder?.connection !== connection ||
      typeof record.epoch !== "string"
    )
      throw new NativeGuardError(
        "ownership",
        `Computer Use refused: ${NOT_OWNER}`,
      );
    return record.epoch;
  };
}

function relabel(error: unknown, input: boolean): NativeGuardError {
  if (error instanceof NativeGuardError) return error;
  const { category, code } = classify(error);
  let message = `${error instanceof Error ? error.message : String(error)} [${category}${code ? `: ${code}` : ""}]`;
  if (category === "interruption")
    message +=
      " The user stopped or took over the session. Do not repeat the input; ask the user before you continue.";
  else if (input && !NO_EFFECT.has(category))
    message +=
      " The effect of this input is unknown. Observe the app before further input; input to this app stays refused until then.";
  return new NativeGuardError(category, message, code, error);
}

// The guard state for each canonical app path that an observation returned.
// Each mark is a position in one sequence of guard events. The worker runs
// requests concurrently, so an observation that began before an input ended
// cannot clear the marks of that input.
type AppMarks = {
  // The start of the last successful observation.
  observed: number;
  // The end of the last input that can have changed the app. Element indices
  // from an earlier observation can refer to the layout before that input.
  changed: number;
  // The end of the last input with an unknown effect.
  uncertain: number;
  // The number of inputs in progress.
  pending: number;
  // The lease epoch of the last successful observation. Another runtime can
  // have changed the app under a later epoch.
  epoch: string;
};

export function createSkyGuard(
  load: () => Promise<SkyService>,
  owner: OwnerCheck,
): SkyService {
  let provider: Promise<SkyService> | undefined;
  const apps = new Map<string, AppMarks>();
  let sequence = 0;
  const inner = (request: unknown) =>
    (provider ??= load()).then((handle) => handle(request));

  async function execute(request: Record<string, unknown>): Promise<unknown> {
    const { method, args } = request;
    if (typeof method !== "string" || !Array.isArray(args))
      return refuse("malformed Sky execute request");
    if (!OBSERVATIONS.has(method) && !INPUTS.has(method))
      return refuse(`the Sky method is not available: ${method}`);
    // Every forwarded request needs the lease, also when a grant answers its
    // approval without a dialog.
    const epoch = owner();
    if (method === "list_apps") {
      if (args.length !== 0) return refuse("list_apps takes no arguments");
      try {
        return await inner(request);
      } catch (error) {
        throw relabel(error, false);
      }
    }
    const options = args[0];
    if (args.length !== 1 || !plain(options))
      return refuse(`${method} requires one options object`);
    const app = options.app;
    if (typeof app !== "string" || app.trim() === "")
      return refuse(`${method} requires an app`);
    if (method === "get_app_state") {
      const start = ++sequence;
      let result: unknown;
      try {
        result = await inner(request);
      } catch (error) {
        throw relabel(error, false);
      }
      if (!plain(result) || typeof result.app !== "string" || !result.app)
        throw new NativeGuardError(
          "observation",
          "The Sky service returned an observation without an app identity",
        );
      const marks = apps.get(result.app);
      if (marks && marks.epoch === epoch)
        marks.observed = Math.max(marks.observed, start);
      else if (marks) {
        marks.observed = start;
        marks.epoch = epoch;
      } else
        apps.set(result.app, {
          observed: start,
          changed: 0,
          uncertain: 0,
          pending: 0,
          epoch,
        });
      return result;
    }
    if (
      method === "drag" ||
      Object.hasOwn(options, "x") ||
      Object.hasOwn(options, "y")
    )
      return refuse(COORDINATE_REFUSAL);
    if (
      INDEXED.has(method) &&
      !(
        Number.isSafeInteger(options.element_index) &&
        (options.element_index as number) >= 0
      )
    )
      return refuse(
        `${method} requires an element index from a current accessibility observation`,
      );
    const marks = apps.get(app);
    if (marks === undefined)
      return refuse(
        `input requires an app that an observation bound in this runtime: ${app}. Bind it with cua.getApp() first.`,
      );
    if (marks.epoch !== epoch)
      return refuse(
        `another Claude Code session or agent controlled the computer after this runtime observed ${app}. Observe the app again before further input.`,
      );
    if (marks.pending > 0)
      return refuse(
        `another input to ${app} has not finished. Await each input before the next one.`,
      );
    if (marks.uncertain > marks.observed)
      return refuse(
        `the effect of an earlier input to ${app} is unknown. Observe the app again before further input.`,
      );
    // Keys and text use no element index, so they can follow other input.
    if (INDEXED.has(method) && marks.changed > marks.observed)
      return refuse(
        `the element indices for ${app} are from before its last input. Observe the app again before input by element index.`,
      );
    marks.pending++;
    try {
      const result = await inner(request);
      marks.changed = ++sequence;
      return result;
    } catch (error) {
      const relabeled = relabel(error, true);
      if (!NO_EFFECT.has(relabeled.category))
        marks.changed = marks.uncertain = ++sequence;
      throw relabeled;
    } finally {
      marks.pending--;
    }
  }

  return async (request) => {
    if (!plain(request)) return refuse("malformed Sky request");
    switch (request.type) {
      case "setup": {
        let value: unknown;
        try {
          value = await inner(request);
        } catch (error) {
          throw relabel(error, false);
        }
        if (
          !plain(value) ||
          value.target !== "mac" ||
          !Array.isArray(value.methods)
        )
          throw new NativeGuardError(
            "protocol",
            "The Sky service did not report the reviewed macOS client",
          );
        return {
          ...value,
          methods: value.methods.filter(
            (name) => OBSERVATIONS.has(name) || INPUTS.has(name),
          ),
        };
      }
      case "execute":
        return execute(request);
      default:
        return refuse(
          `the Sky request type is not available on macOS: ${String(request.type)}`,
        );
    }
  };
}

// The worker resolves the provider handler from the declared module
// directories, as it resolves a configured package name.
async function loadProvider(): Promise<SkyService> {
  for (const directory of (process.env.NODE_REPL_NODE_MODULE_DIRS ?? "")
    .split(delimiter)
    .filter(Boolean)) {
    let resolved: string;
    try {
      resolved = createRequire(join(directory, "sky-guard.js")).resolve(
        "@oai/sky/service",
      );
    } catch {
      continue;
    }
    const providerUrl = pathToFileURL(resolved).href;
    const module = await import(providerUrl);
    if (typeof module.handleRpc !== "function")
      throw new NativeGuardError(
        "protocol",
        "The reviewed Sky service does not export handleRpc",
      );
    return module.handleRpc;
  }
  throw new NativeGuardError(
    "protocol",
    "The reviewed Sky service is unavailable",
  );
}

export const handleRpc = createSkyGuard(loadProvider, leaseOwner());
