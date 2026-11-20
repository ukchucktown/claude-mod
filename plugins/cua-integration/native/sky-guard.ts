// The trusted `sky` service handler. The launcher configures this module in
// place of the provider handler, and the runtime's trusted worker loads it.
// Model JavaScript cannot reach the native pipe itself, so every native request
// passes here: the cua facade, a direct `@oai/sky` import, and a raw
// `nodeRepl.rpc("sky", ...)` call alike.
//
// The worker accepts only files under a configured trusted code path and loads
// this file with type stripping. Keep it self-contained, with Node imports only.
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { delimiter, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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
  | "intervention"
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

// Each reviewed method by name. The launcher checks that an installed Sky
// client still has each one.
export const REVIEWED_METHODS: readonly string[] = Object.freeze([
  ...OBSERVATIONS,
  ...INPUTS,
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
  // The two user codes differ (decision record 0004). A stopped session ends
  // the work. An intervention is an action in an app, so it is a failure with
  // an unknown effect and no more.
  userStoppedSession: "interruption",
  userIntervened: "intervention",
  accessibilityError: "accessibility",
  incompatibleClientVersion: "protocol",
  couldNotGetRequestData: "protocol",
  couldNotGetRequestTypeName: "protocol",
  couldNotResolveRequestType: "protocol",
  unhandledEvent: "protocol",
};

// The methods that take one point of the screenshot. `drag` takes two points.
const POINTED = new Set(["click", "scroll"]);

// The limits of the standard resolution tier of the Claude API: the longest
// side in pixels, the number of patches, and the side of one patch. The API
// leaves an image within these limits at its size for each model, so the
// model reads a coordinate pair from the pixels that the launcher delivered.
// Decision record 0005 gives the source of the numbers.
const MODEL_EDGE = 1568;
const MODEL_PATCHES = 1568;
const PATCH = 28;

export type PixelSize = { width: number; height: number };

// The size of the image that the model receives for a source image: the
// largest size with the proportions of the source that is within the limits.
// The launcher scales each larger image to this size before delivery, and
// the guard relates a coordinate pair to it. An image within the limits
// keeps its size.
export function modelImageSize({ width, height }: PixelSize): PixelSize {
  const fits = (w: number, h: number) =>
    Math.ceil(w / PATCH) * PATCH <= MODEL_EDGE &&
    Math.ceil(h / PATCH) * PATCH <= MODEL_EDGE &&
    Math.ceil(w / PATCH) * Math.ceil(h / PATCH) <= MODEL_PATCHES;
  if (fits(width, height)) return { width, height };
  if (height > width) {
    const turned = modelImageSize({ width: height, height: width });
    return { width: turned.height, height: turned.width };
  }
  const short = (long: number) =>
    Math.max(1, Math.round((long * height) / width));
  // `low` always fits, and `high` never fits.
  let low = 1;
  let high = width;
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2);
    if (fits(middle, short(middle))) low = middle;
    else high = middle;
  }
  return { width: low, height: short(low) };
}

// The pixel size in the header of a PNG or a JPEG image. The native service
// gives its screenshots in these two formats.
export function imageSize(bytes: Uint8Array): PixelSize | undefined {
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let size: PixelSize | undefined;
  if (
    view.length >= 24 &&
    view.readUInt32BE(0) === 0x89504e47 &&
    view.toString("latin1", 12, 16) === "IHDR"
  )
    size = { width: view.readUInt32BE(16), height: view.readUInt32BE(20) };
  else if (view.length >= 4 && view[0] === 0xff && view[1] === 0xd8)
    for (let offset = 2; offset + 9 <= view.length && view[offset] === 0xff; ) {
      const marker = view[offset + 1]!;
      // The data of the image starts here, with no frame header before it.
      if (marker === 0xd9 || marker === 0xda) break;
      if (marker === 0xff) offset += 1;
      else if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7))
        offset += 2;
      else if (
        marker >= 0xc0 &&
        marker <= 0xcf &&
        marker !== 0xc4 &&
        marker !== 0xc8 &&
        marker !== 0xcc
      ) {
        size = {
          width: view.readUInt16BE(offset + 7),
          height: view.readUInt16BE(offset + 5),
        };
        break;
      } else offset += 2 + view.readUInt16BE(offset + 2);
    }
  return size && size.width > 0 && size.height > 0 ? size : undefined;
}

// The screenshot of one observation: the size of the image that the model
// receives, the size of the native screenshot, and the SHA-256 digest of the
// bytes of the native screenshot. The input coordinates of the native service
// are pixels of the native screenshot. The digest identifies the screenshot
// in the delivery record of the launcher.
type Frame = { model: PixelSize; native: PixelSize; sha256: string };

const DATA_URL = /^data:image\/(?:png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/;

// Reads the frame of a native screenshot, which is a file URL or a data URL.
// A screenshot of an unknown size gives no frame, and then it permits no
// coordinate input.
async function frameOf(url: string): Promise<Frame | undefined> {
  try {
    const data = DATA_URL.exec(url)?.[1];
    const bytes = url.startsWith("file:")
      ? await readFile(fileURLToPath(url))
      : data === undefined
        ? undefined
        : Buffer.from(data, "base64");
    const native = bytes && imageSize(bytes);
    return (
      native && {
        model: modelImageSize(native),
        native,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      }
    );
  } catch {
    return undefined;
  }
}

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

// The number of pixels for each point of a display that the coordinate
// record covers. Decision record 0005 holds that evidence.
export const MEASURED_DISPLAY_SCALE = 2;
// How old a reading of the display scales can be at a coordinate request.
// The launcher reads the displays before it sends a call to the runtime, so
// a coordinate request late in a long call has an old reading, and the guard
// refuses it.
export const DISPLAY_MAX_AGE_MS = 60_000;

// What the launcher reports for one screenshot: whether it delivered an
// image with these bytes to the model, and the scale of each display at its
// last reading. `scales` is undefined when the scales are unknown.
export type Delivery = {
  received: boolean;
  scales: readonly number[] | undefined;
};
export type DeliveryCheck = (sha256: string) => Delivery;

// The launcher names its delivery record in the environment. The value
// matches implementation/connection/ownership.ts, which this self-contained
// file cannot import.
const DELIVERY_ENV = "CLAUDE_CUA_DELIVERY";

// Reads the delivery record on each coordinate request. The guard runs in
// the trusted worker, and only the launcher sees which images a result holds
// and whether it scaled each one. Thus, the launcher writes the digest of
// each image that it delivered, before it returns the result, and the guard
// reads the record. The record also holds the scale of each display, which
// only the launcher can read. A missing, unsafe, or unreadable record, and a
// record of another connection, report no delivery and unknown scales. So do
// a record without the scales, a malformed reading, and a reading that is
// older than the limit or from the future.
export function deliveredImages(
  env: Record<string, string | undefined> = process.env,
  now: () => number = Date.now,
): DeliveryCheck {
  return (sha256) => {
    const nothing: Delivery = { received: false, scales: undefined };
    const path = env[DELIVERY_ENV];
    const connection = env[CONNECTION_ENV];
    if (!path || !connection) return nothing;
    try {
      const stat = lstatSync(path);
      if (
        !stat.isFile() ||
        stat.uid !== process.getuid?.() ||
        (stat.mode & 0o077) !== 0
      )
        return nothing;
      const record = JSON.parse(readFileSync(path, "utf8"));
      if (record?.connection !== connection) return nothing;
      const displays = record.displays;
      const age = now() - displays?.readAt;
      const scales =
        Array.isArray(displays?.scales) &&
        displays.scales.length > 0 &&
        displays.scales.every(
          (scale: unknown) => Number.isFinite(scale) && (scale as number) > 0,
        ) &&
        age >= 0 &&
        age <= DISPLAY_MAX_AGE_MS
          ? (displays.scales as number[])
          : undefined;
      return {
        received:
          Array.isArray(record.images) && record.images.includes(sha256),
        scales,
      };
    } catch {
      return nothing;
    }
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
  else if (category === "intervention")
    message +=
      " Observe each app again before further input; input to each app stays refused until then.";
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
  // The screenshot of the last successful observation. A coordinate pair
  // refers to it, after the launcher delivered it. It is undefined when that
  // observation gave no screenshot of a known size.
  frame: Frame | undefined;
};

export function createSkyGuard(
  load: () => Promise<SkyService>,
  owner: OwnerCheck,
  // Without a delivery check, no screenshot counts as delivered and the
  // display scales are unknown, so the guard refuses each coordinate pair.
  delivered: DeliveryCheck = () => ({ received: false, scales: undefined }),
): SkyService {
  let provider: Promise<SkyService> | undefined;
  const apps = new Map<string, AppMarks>();
  let sequence = 0;
  // The position of the last user intervention that an observation reported.
  // An observation that started before it shows a state from before the
  // intervention, also for an app that had no entry at that time.
  let intervened = 0;
  const inner = (request: unknown) =>
    (provider ??= load()).then((handle) => handle(request));
  // An observation that fails names no canonical app path. After a user
  // intervention, each bound app can differ from its last observation, so
  // each one waits for a new observation.
  const observe = async (request: unknown): Promise<unknown> => {
    try {
      return await inner(request);
    } catch (error) {
      const relabeled = relabel(error, false);
      if (relabeled.category === "intervention") {
        intervened = ++sequence;
        for (const marks of apps.values())
          marks.changed = marks.uncertain = intervened;
      }
      throw relabeled;
    }
  };

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
      return observe(request);
    }
    const options = args[0];
    if (args.length !== 1 || !plain(options))
      return refuse(`${method} requires one options object`);
    const app = options.app;
    if (typeof app !== "string" || app.trim() === "")
      return refuse(`${method} requires an app`);
    if (method === "get_app_state") {
      const start = ++sequence;
      const result = await observe(request);
      if (!plain(result) || typeof result.app !== "string" || !result.app)
        throw new NativeGuardError(
          "observation",
          "The Sky service returned an observation without an app identity",
        );
      const frame =
        plain(result.screenshot) && typeof result.screenshot.url === "string"
          ? await frameOf(result.screenshot.url)
          : undefined;
      const marks = apps.get(result.app);
      if (marks && marks.epoch === epoch) {
        // An observation that started before the last one is older than it,
        // so its screenshot does not replace the frame.
        if (start > marks.observed) {
          marks.observed = start;
          marks.frame = frame;
        }
      } else if (marks) {
        marks.observed = start;
        marks.epoch = epoch;
        marks.frame = frame;
      } else
        // The first observation of an app can be in flight when another
        // observation reports an intervention. Its result is then older
        // than the intervention, so the new entry waits for a newer
        // observation, as each bound app does.
        apps.set(result.app, {
          observed: start,
          changed: intervened,
          uncertain: intervened,
          pending: 0,
          epoch,
          frame,
        });
      return result;
    }
    // The names of the coordinate fields of this request, one pair for each
    // point of the screenshot.
    const pairs: ReadonlyArray<readonly [string, string]> =
      method === "drag"
        ? [
            ["from_x", "from_y"],
            ["to_x", "to_y"],
          ]
        : Object.hasOwn(options, "x") || Object.hasOwn(options, "y")
          ? [["x", "y"]]
          : [];
    if (pairs.length > 0) {
      if (method !== "drag" && !POINTED.has(method))
        return refuse(`${method} takes no coordinate pair`);
      // The native service uses the index when a request has the two, so
      // the request would name two targets.
      if (Object.hasOwn(options, "element_index"))
        return refuse(
          `${method} takes an element index or a coordinate pair, not the two`,
        );
      if (!pairs.flat().every((name) => Number.isFinite(options[name])))
        return refuse(
          `${method} requires a finite number for each of ${pairs.flat().join(", ")}`,
        );
    } else if (
      INDEXED.has(method) &&
      !(
        Number.isSafeInteger(options.element_index) &&
        (options.element_index as number) >= 0
      )
    )
      return refuse(
        `${method} requires an element index from a current accessibility observation, or a coordinate pair of the current screenshot`,
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
    if (pairs.length === 0 && INDEXED.has(method)) {
      if (marks.changed > marks.observed)
        return refuse(
          `the element indices for ${app} are from before its last input. Observe the app again before input by element index.`,
        );
    } else if (pairs.length > 0) {
      // A coordinate pair refers to one screenshot: that of the last
      // observation, which must have started after the last input ended.
      if (marks.changed > marks.observed)
        return refuse(
          `the screenshot of ${app} is from before its last input. Observe the app again with a screenshot before input by coordinates.`,
        );
      const frame = marks.frame;
      if (frame === undefined)
        return refuse(
          `the last observation of ${app} gave no screenshot. Observe the app again with a screenshot before input by coordinates.`,
        );
      // The script receives a screenshot from each observation, also from
      // one that emits only text, and the launcher can withhold an image
      // that it cannot scale. The model reads a pair from an image that it
      // received, so the screenshot of the last observation must be an image
      // that the launcher delivered. The launcher records an image when it
      // returns the result, so a pair in the call of the observation fails.
      const delivery = delivered(frame.sha256);
      // The evidence for the transform is from displays with one scale. The
      // guard cannot read the scale of a window from an observation, so it
      // permits a pair only while each display has that scale.
      const limit = `Coordinate input is limited to displays with ${MEASURED_DISPLAY_SCALE} pixels for each point, which is the only display scale that the evidence for coordinate input covers.`;
      if (delivery.scales === undefined)
        return refuse(
          `the scale of each display is unknown. ${limit} The launcher has no current reading of the display scales, so the current display configuration is not known to be within that limit. Use an element index, or observe the app again with a screenshot and send the coordinate pair at the start of a later call.`,
        );
      if (delivery.scales.some((scale) => scale !== MEASURED_DISPLAY_SCALE))
        return refuse(
          `the current display configuration is outside the limit of coordinate input. ${limit} The displays have these scales: ${delivery.scales.join(", ")}. Use an element index from the accessibility text.`,
        );
      if (!delivery.received)
        return refuse(
          `the model did not receive the screenshot of the last observation of ${app}. Observe the app again with a screenshot, end the call, and send the coordinate pair in a later call.`,
        );
      const { model, native } = frame;
      const converted: Record<string, number> = {};
      for (const [x, y] of pairs) {
        const column = options[x] as number;
        const row = options[y] as number;
        if (
          column < 0 ||
          row < 0 ||
          column >= model.width ||
          row >= model.height
        )
          return refuse(
            `the point (${column}, ${row}) is outside the screenshot of ${app}, which has ${model.width} by ${model.height} pixels. A coordinate pair is a pixel of that screenshot, from its top left corner.`,
          );
        // The native service takes a pixel of its own screenshot.
        converted[x] = Math.min(
          native.width - 1,
          Math.round((column * native.width) / model.width),
        );
        converted[y] = Math.min(
          native.height - 1,
          Math.round((row * native.height) / model.height),
        );
      }
      request = { ...request, args: [{ ...options, ...converted }] };
    }
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

export const handleRpc = createSkyGuard(
  loadProvider,
  leaseOwner(),
  deliveredImages(),
);
