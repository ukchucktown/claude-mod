// The trusted `sky` service handler. The launcher configures this module in
// place of the provider handler, and the runtime's trusted worker loads it.
// Model JavaScript cannot reach the native pipe itself, so every native request
// passes here: the cua facade, a direct `@oai/sky` import, and a raw
// `nodeRepl.rpc("sky", ...)` call alike.
//
// The worker accepts only files under a configured trusted code path and loads
// this file with type stripping. Keep it self-contained, with Node imports only.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, delimiter, isAbsolute, join } from "node:path";
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
  | "visibility"
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

// The native service gives some failures the code `unknownError` and names
// the cause only in the message. Each entry is a reviewed message of that
// code. Each other message of the code keeps the category `unknown`.
// `noWindowsAvailable` is the failure of pointer input to an app with no
// window that a display shows, for example a window on another Space. The
// hidden Space record shows it for a click and a scroll at a coordinate
// pair, for a drag, and for a scroll by element index. In that record, a
// click by element index, a key press, typed text, and a value assignment
// reach the same window, and a text selection fails with another message.
const UNKNOWN_ERROR_CATEGORIES: ReadonlyArray<
  readonly [RegExp, FailureCategory]
> = [[/^Computer Use server error -?\d+: noWindowsAvailable$/, "visibility"]];

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

// The number of characters of one result at which the result does not arrive
// at the launcher. The text of a result counts with each character, and an
// image counts as base64 text, which is four characters for each three
// bytes. The result size record gives the source: a result with 16,637,408
// characters of image data arrived, and each result with this number of
// characters or more did not arrive, as images, as text, and as the two.
export const RESULT_LIMIT_CHARACTERS = 2 ** 24;
// The characters that the guard keeps free in a result for a screenshot that
// it could not scale: the frame of the result, and each other output of the
// script. The value is a margin and not a measured number. In the result
// size record, a result with 139,808 characters below the limit arrived.
export const RESULT_RESERVE_CHARACTERS = 1024 * 1024;

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
// receives, the size of the native screenshot, and the SHA-256 digest that
// identifies the screenshot in the delivery record of the launcher. The
// digest is that of the bytes of the native screenshot, or that of the
// scaled image without its reference when the guard scaled the screenshot.
// The input coordinates of the native service are pixels of the native
// screenshot.
type Frame = { model: PixelSize; native: PixelSize; sha256: string };

const DATA_URL = /^data:image\/(?:png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/;

// A capture is the file of a native screenshot at the size of the native
// service. A capture reference names one capture: the name of its file in
// the screenshot folder of the native service, and the SHA-256 digest of its
// bytes. The guard writes the reference into the image that it scaled, so
// the launcher can read the capture for the region tool (decision record
// 0009).
//
// `image` is the SHA-256 digest of the scaled image without the reference.
// It binds the reference to the pixels of that image: an image with other
// bytes and the same reference has another digest, so the launcher does not
// read a capture for it. It is also the digest of the delivery record, so
// two captures with the same bytes and other names give one digest.
export type CaptureReference = { name: string; sha256: string; image: string };

// The start of the JPEG comment segment that holds a capture reference. The
// two digests and the name of the file follow it.
const REFERENCE_PREFIX = "claude-cua capture 1 ";
// The longest name of a file in bytes.
const NAME_LIMIT = 255;
const DIGEST = /^[0-9a-f]{64}$/;
const digestOf = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

function validReference({ name, sha256, image }: CaptureReference): boolean {
  return (
    DIGEST.test(sha256) &&
    DIGEST.test(image) &&
    name.length > 0 &&
    Buffer.byteLength(name, "utf8") <= NAME_LIMIT &&
    name !== "." &&
    name !== ".." &&
    !/[/\\\0]/.test(name)
  );
}

// Adds a capture reference to a JPEG image as a comment segment, after the
// application segments at the start of the image. The reference gets the
// digest of the image as it is before this step. A value that is no JPEG
// image, and a name or a digest that is not valid, give undefined.
export function withCaptureReference(
  jpeg: Uint8Array,
  capture: Pick<CaptureReference, "name" | "sha256">,
): Buffer | undefined {
  const view = Buffer.from(jpeg.buffer, jpeg.byteOffset, jpeg.byteLength);
  const reference = { ...capture, image: digestOf(view) };
  if (
    view.length < 4 ||
    view[0] !== 0xff ||
    view[1] !== 0xd8 ||
    !validReference(reference)
  )
    return undefined;
  let offset = 2;
  while (
    offset + 4 <= view.length &&
    view[offset] === 0xff &&
    view[offset + 1]! >= 0xe0 &&
    view[offset + 1]! <= 0xef
  )
    offset += 2 + view.readUInt16BE(offset + 2);
  if (offset > view.length) return undefined;
  const text = Buffer.from(
    `${REFERENCE_PREFIX}${reference.sha256} ${reference.image} ${reference.name}`,
    "utf8",
  );
  const header = Buffer.from([0xff, 0xfe, 0, 0]);
  header.writeUInt16BE(text.length + 2, 2);
  return Buffer.concat([
    view.subarray(0, offset),
    header,
    text,
    view.subarray(offset),
  ]);
}

// Finds the comment segment of a JPEG image that holds a capture reference,
// before the picture data: its first byte, the byte after its last byte, and
// the reference. A segment with a reference of another form gives undefined.
function referenceSegment(
  view: Buffer,
): { start: number; end: number; reference: CaptureReference } | undefined {
  if (view.length < 4 || view[0] !== 0xff || view[1] !== 0xd8) return undefined;
  for (let offset = 2; offset + 4 <= view.length && view[offset] === 0xff; ) {
    const marker = view[offset + 1]!;
    // The picture data starts here.
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const length = view.readUInt16BE(offset + 2);
    if (length < 2 || offset + 2 + length > view.length) break;
    const end = offset + 2 + length;
    if (marker === 0xfe) {
      const text = view.toString("utf8", offset + 4, end);
      if (text.startsWith(REFERENCE_PREFIX)) {
        const rest = text.slice(REFERENCE_PREFIX.length);
        const reference = {
          sha256: rest.slice(0, 64),
          image: rest.slice(65, 129),
          name: rest.slice(130),
        };
        return rest[64] === " " &&
          rest[129] === " " &&
          validReference(reference)
          ? { start: offset, end, reference }
          : undefined;
      }
    }
    offset = end;
  }
  return undefined;
}

// Reads the capture reference of a JPEG image, or of the first bytes of one.
// An image without a valid reference before its picture data gives
// undefined. The function does not compare the digest of the image, so a
// caller that reads a capture for the image uses `referencedImage`.
export function captureReference(
  jpeg: Uint8Array,
): CaptureReference | undefined {
  return referenceSegment(
    Buffer.from(jpeg.buffer, jpeg.byteOffset, jpeg.byteLength),
  )?.reference;
}

// Reads the capture reference of a JPEG image that the guard scaled, with
// the digest of the image without the reference. The function gives a result
// only when that digest is the digest that the reference holds. Thus, an
// image whose pixels changed after the guard scaled it has no reference.
export function referencedImage(
  jpeg: Uint8Array,
): { reference: CaptureReference; sha256: string } | undefined {
  const view = Buffer.from(jpeg.buffer, jpeg.byteOffset, jpeg.byteLength);
  const segment = referenceSegment(view);
  if (!segment) return undefined;
  const sha256 = createHash("sha256")
    .update(view.subarray(0, segment.start))
    .update(view.subarray(segment.end))
    .digest("hex");
  return sha256 === segment.reference.image
    ? { reference: segment.reference, sha256 }
    : undefined;
}

// Scales the image of a file to an exact pixel size and returns it as a JPEG
// image. The function writes no file.
export type CaptureScale = (path: string, size: PixelSize) => Promise<Buffer>;

// The script that scales a capture. It runs in the JavaScript interpreter of
// `osascript` and uses the image classes of macOS. It reads the file, draws
// the image at the new size in memory, and prints the JPEG image as base64
// text. The trusted worker cannot write a file, and the image tool `sips`
// writes its result only to a file, so the guard cannot use that tool. The
// script receives the path and the size as arguments, and no value of a
// request is a part of its text.
const SCALE_SCRIPT = `ObjC.import("AppKit");
function run(argv) {
  const width = Number(argv[1]);
  const height = Number(argv[2]);
  const data = $.NSData.dataWithContentsOfFile(argv[0]);
  if (data.isNil()) throw new Error("no data");
  const source = $.NSBitmapImageRep.imageRepWithData(data);
  if (source.isNil()) throw new Error("no image");
  const target = $.NSBitmapImageRep.alloc.initWithBitmapDataPlanesPixelsWidePixelsHighBitsPerSampleSamplesPerPixelHasAlphaIsPlanarColorSpaceNameBytesPerRowBitsPerPixel(null, width, height, 8, 4, true, false, $.NSDeviceRGBColorSpace, 0, 0);
  const context = $.NSGraphicsContext.graphicsContextWithBitmapImageRep(target);
  $.NSGraphicsContext.setCurrentContext(context);
  context.imageInterpolation = $.NSImageInterpolationHigh;
  source.drawInRect($.NSMakeRect(0, 0, width, height));
  context.flushGraphics;
  const properties = $.NSDictionary.dictionaryWithObjectForKey($.NSNumber.numberWithDouble(0.85), $.NSImageCompressionFactor);
  const jpeg = target.representationUsingTypeProperties($.NSBitmapImageFileTypeJPEG, properties);
  return ObjC.unwrap(jpeg.base64EncodedStringWithOptions(0));
}`;
// The time limit of one scale step, in milliseconds. The capture scale
// record gives the time of a step.
const SCALE_TIMEOUT_MS = 10_000;
// The limit for the output of one scale step, in characters. An image at
// the size for the model is far below it.
const SCALE_OUTPUT_LIMIT = 8 * 1024 * 1024;

// The scale step of the trusted worker. The process gets no variable of the
// environment of the worker.
export const scaleInMemory: CaptureScale = (path, { width, height }) =>
  new Promise((done, fail) =>
    execFile(
      "/usr/bin/osascript",
      [
        "-l",
        "JavaScript",
        "-e",
        SCALE_SCRIPT,
        path,
        String(width),
        String(height),
      ],
      {
        timeout: SCALE_TIMEOUT_MS,
        killSignal: "SIGKILL",
        maxBuffer: SCALE_OUTPUT_LIMIT,
        env: {},
      },
      (error, stdout) => {
        if (error) return fail(error);
        const text = String(stdout).trim();
        if (!/^[A-Za-z0-9+/]+={0,2}$/.test(text))
          return fail(new Error("The scale step printed no image"));
        done(Buffer.from(text, "base64"));
      },
    ),
  );

// What the guard gives the script for the screenshot of one observation:
// the frame of the screenshot, and the screenshot value that takes the place
// of the value of the native service. `screenshot` is undefined when the
// value of the native service stays.
type Prepared = {
  frame: Frame | undefined;
  screenshot?: { url: string } | null;
};

// Prepares the screenshot of one observation, which is a file URL or a data
// URL. A screenshot of an unknown size gives no frame, and then it permits
// no coordinate input. `text` is the text of the observation.
//
// The launcher scales an image above the limits of `modelImageSize` only
// after the result of a call arrived, and a result at the size limit does
// not arrive. Thus, the guard scales the capture of such a screenshot before
// the script receives it. The script then holds an image at the size for the
// model, with a reference to the capture. The launcher delivers such an
// image with its bytes unchanged. The digest of the frame is the digest of
// the scaled image without its reference, which the launcher calculates from
// the delivered image.
//
// When the guard cannot scale a capture, the launcher scales it, as it does
// for each image that a script emits. A result with that capture, with the
// text of the observation, and with the reserve of the guard must be below
// the size limit of a result. When it is not, the guard withholds the
// screenshot, and the text of the observation arrives without it. This rule
// applies also to a screenshot of an unknown size.
async function prepare(
  url: string,
  scale: CaptureScale | undefined,
  text: string,
): Promise<Prepared> {
  try {
    const data = DATA_URL.exec(url)?.[1];
    const path = url.startsWith("file:") ? fileURLToPath(url) : undefined;
    const bytes =
      path !== undefined
        ? await readFile(path)
        : data === undefined
          ? undefined
          : Buffer.from(data, "base64");
    if (!bytes) return { frame: undefined };
    // The capture as base64 text, the text as UTF-8 bytes, and the reserve.
    const withheld: Prepared | undefined =
      Math.ceil(bytes.length / 3) * 4 +
        Buffer.byteLength(text, "utf8") +
        RESULT_RESERVE_CHARACTERS >=
      RESULT_LIMIT_CHARACTERS
        ? { frame: undefined, screenshot: null }
        : undefined;
    const native = imageSize(bytes);
    if (!native) return withheld ?? { frame: undefined };
    const model = modelImageSize(native);
    const sha256 = digestOf(bytes);
    if (
      scale &&
      path !== undefined &&
      isAbsolute(path) &&
      (model.width !== native.width || model.height !== native.height)
    )
      try {
        const scaled = await scale(path, model);
        const size = imageSize(scaled);
        const image =
          size?.width === model.width && size.height === model.height
            ? withCaptureReference(scaled, { name: basename(path), sha256 })
            : undefined;
        if (image)
          return {
            frame: { model, native, sha256: digestOf(scaled) },
            screenshot: {
              url: `data:image/jpeg;base64,${image.toString("base64")}`,
            },
          };
      } catch {
        // The launcher scales the capture, or the guard withholds it below.
      }
    return withheld ?? { frame: { model, native, sha256 } };
  } catch {
    return { frame: undefined };
  }
}

// An app that shows the session of another computer and that the guard does
// not start. The native service starts an app that does not run when it
// receives an observation of that app. The viewer start record of issue #144
// shows that such a start of Citrix Viewer gives a process with no session
// and no window, which does not exit, and each later observation of the
// viewer then ends at the time limit of the native service. The list has
// the one app of that record.
const SESSION_VIEWERS: ReadonlyArray<{ id: string; name: string }> = [
  { id: "com.citrix.receiver.icaviewer.mac", name: "Citrix Viewer" },
];
// The viewer that a selector names, by its bundle identifier, by its name,
// or by a path that ends with the name of its bundle.
function sessionViewer(app: string) {
  const lower = app.toLowerCase();
  return SESSION_VIEWERS.find(
    ({ id, name }) =>
      app === id ||
      lower === name.toLowerCase() ||
      lower.endsWith(`/${name.toLowerCase()}.app`),
  );
}
// Tells whether the app list of the native service shows a process of the
// app that runs. The list is an array of entries with an `id`, and an entry
// of a process that runs has `isRunning: true`. An empty list and a value
// of another form give undefined, because they show nothing about the app.
export function listedAsRunning(
  list: unknown,
  id: string,
): boolean | undefined {
  if (
    !Array.isArray(list) ||
    list.length === 0 ||
    !list.every((entry) => plain(entry) && typeof entry.id === "string")
  )
    return undefined;
  return list.some((entry) => entry.id === id && entry.isRunning === true);
}
// The refusal of an observation that would start a viewer.
export const viewerRefusal = (name: string) =>
  `Computer Use refused: no process of ${name} runs. An observation would start a viewer with no remote desktop, which shows no window, and each later observation of the viewer then ends at the time limit of the native service. Ask the user to open the remote desktop, and observe the viewer after the user confirms it.`;

// The complete message of an observation that the native service ended at
// its own time limit. The duplicate process record of issue #140 shows it
// for an app whose first process has no window.
const TIMEOUT_REACHED = /^Computer Use server error -?\d+: timeoutReached$/;
// The longest selector of an app that the notice names.
const SELECTOR_LIMIT = 200;
const NOTICE_START = " The observation of the app ";
const NOTICE_END =
  " ended at the time limit of the native service. One known cause is a process of the app that has no window.";
const TIME_LIMIT_LABEL = "timeoutReached [unknown: unknownError]";
// The text that the guard adds to that failure. It names the selector that
// the caller gave, because the trusted worker cannot read the processes of
// an app: the launcher reads them for the selector of a notice at the end
// of a result, and adds its own note.
export const timeLimitNotice = (app: string) =>
  `${NOTICE_START}${JSON.stringify(app.slice(0, SELECTOR_LIMIT))}${NOTICE_END}`;
// The selector in the notice at the end of a text, or undefined. A notice
// at another place of a text can come from the content of an app, so the
// launcher does not read it.
export function timeLimitApp(text: string): string | undefined {
  const trimmed = text.trimEnd();
  if (!trimmed.endsWith(NOTICE_END)) return undefined;
  const body = trimmed.slice(0, -NOTICE_END.length);
  const start = body.lastIndexOf(NOTICE_START);
  if (start < 0 || !body.slice(0, start).endsWith(TIME_LIMIT_LABEL))
    return undefined;
  try {
    const app: unknown = JSON.parse(body.slice(start + NOTICE_START.length));
    return typeof app === "string" && app !== "" && app.length <= SELECTOR_LIMIT
      ? app
      : undefined;
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
  if (error.name === "SkyComputerUseError" && typeof code === "string") {
    const named = NATIVE_CATEGORIES[code];
    if (named) return { category: named, code };
    if (code === "unknownError")
      for (const [pattern, category] of UNKNOWN_ERROR_CATEGORIES)
        if (pattern.test(error.message)) return { category, code };
    return { category: "unknown", code };
  }
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

// `pointer` is true for the inputs that the hidden Space record shows with
// the failure `noWindowsAvailable`: a coordinate pair, a drag, and a scroll.
function relabel(
  error: unknown,
  input: boolean,
  pointer = false,
): NativeGuardError {
  if (error instanceof NativeGuardError) return error;
  const { category, code } = classify(error);
  let message = `${error instanceof Error ? error.message : String(error)} [${category}${code ? `: ${code}` : ""}]`;
  if (category === "interruption")
    message +=
      " The user stopped or took over the session. Do not repeat the input; ask the user before you continue.";
  // In each case of the hidden Space record, the app received no event of
  // the failed input. The guard has no proof of that for each app, so the
  // message makes no claim about the effect, and the next input waits for
  // an observation, as after each other failed input. The message names the
  // inputs that reached the window in that record. It does not name
  // `selectText`, which failed there. An input of another kind
  // with this failure gets the general message, because the record does not
  // show such a case and the advice would name the input that failed.
  else if (input && pointer && category === "visibility")
    message +=
      " No display shows a window of this app, for example because the window is on another Space. A coordinate pair, `drag`, and `scroll` fail there. Input to this app stays refused until a new observation. After it, use `click` by element index, `pressKey`, `typeText`, or `setValue`, or ask the user to show the window.";
  // The intervention record shows the cause of this failure for an input: a
  // click of a person in a window of the app after the last observation of
  // it. The native service then refuses the next input, and an observation
  // ends the refusal. The message tells the model so. It makes no claim
  // about the effect of the input, and the guard keeps the rule of decision
  // record 0004: no input passes before a new observation.
  else if (input && category === "intervention")
    message +=
      " A person acted in this app after your last observation of it, for example with a click in its window, and the native service refuses the next input then. Input to this app stays refused until a new observation. Observe the app, and choose the next input from the new state.";
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
  // True when the text of the last successful observation shows a window
  // with no accessibility content.
  pixelOnly: boolean;
  // The time of the end of the last input to the app, in milliseconds, or 0
  // before the first input.
  inputEnded: number;
};

// The lines of an accessibility text that name an element: a number of tabs
// for the depth, the element index, and the text of the element.
const ELEMENT = /^(\t*)\d+ (.*)$/;
// The controls of the frame of a window. A window that shows only these
// controls to the accessibility interface has its content in pixels only,
// for example the window of a remote desktop client.
// A text is the title of the window. A text field and a text entry area are
// controls of the content.
const FRAME_CONTROL =
  /^(?:close button|full screen button|zoom button|minimize button|text(?! field| entry| area)|menu button)\b/;

// Tells whether an accessibility text shows a window whose only elements
// are the controls of its frame. The pixel window record shows this form for
// a Citrix Viewer window. A text with no window element gives undefined: the
// native service returns the changes since the last observation when the
// caller does not ask for the full text, and such a text names no window.
export function windowContent(text: string): "pixels" | "elements" | undefined {
  let inWindow = false;
  let found = false;
  for (const line of text.split("\n")) {
    const element = ELEMENT.exec(line);
    if (!element) continue;
    const [, depth, rest] = element as unknown as [string, string, string];
    if (depth === "") {
      inWindow = /^(?:standard )?window\b/.test(rest);
      found ||= inWindow;
    } else if (inWindow && (depth.length > 1 || !FRAME_CONTROL.test(rest)))
      return "elements";
  }
  return found ? "pixels" : undefined;
}
// True when an accessibility text shows a window with no accessibility
// content.
export const pixelOnlyWindow = (text: string): boolean =>
  windowContent(text) === "pixels";

// The time that the guard gives the content of a window with no
// accessibility content after an input, in milliseconds. The native service
// waits for a change of the accessibility text before an observation, and
// such a window has no such change, so an observation directly after an
// input can show the screen from before the input. The pixel window record
// gives the source of the value.
export const SETTLE_MS = 1000;
// The environment variable that gives the guard another time. The launcher
// sets it from its setting `CUA_SETTLE_MS`. The value 0 removes the wait.
export const SETTLE_ENV = "CLAUDE_CUA_SETTLE_MS";
// The environment variable that turns the scale step of the guard off. The
// launcher sets it from its setting `CUA_CAPTURE_SCALE`. With the value 0,
// the guard scales no capture, and the launcher scales each image, as before
// decision record 0009. Each other value, and no value, keep the scale step.
export const CAPTURE_SCALE_ENV = "CLAUDE_CUA_CAPTURE_SCALE";
// The scale step of the guard from its environment.
export function captureScale(
  env: Record<string, string | undefined> = process.env,
): CaptureScale | undefined {
  return env[CAPTURE_SCALE_ENV] === "0" ? undefined : scaleInMemory;
}
// How many names of apps the guard keeps for the lookup of an app entry.
const ALIAS_LIMIT = 64;
export type GuardTiming = {
  settleMs: number;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
};
// The time of the guard from its environment. A value that is no whole
// number from 0 to 10000 gives the default time.
export function guardTiming(
  env: Record<string, string | undefined> = process.env,
): GuardTiming {
  const value = env[SETTLE_ENV];
  const parsed =
    value !== undefined && /^\d+$/.test(value) ? Number(value) : NaN;
  return {
    settleMs: parsed >= 0 && parsed <= 10000 ? parsed : SETTLE_MS,
    now: Date.now,
    sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
  };
}

export function createSkyGuard(
  load: () => Promise<SkyService>,
  owner: OwnerCheck,
  // Without a delivery check, no screenshot counts as delivered and the
  // display scales are unknown, so the guard refuses each coordinate pair.
  delivered: DeliveryCheck = () => ({ received: false, scales: undefined }),
  // The settle time of a window with no accessibility content, with the
  // clock and the wait of the guard. A test gives its own clock.
  timing: GuardTiming = guardTiming({}),
  // The scale step for a capture above the limits of `modelImageSize`.
  // Without it, the guard scales no capture, and the launcher scales each
  // image, as before decision record 0009.
  scale?: CaptureScale,
): SkyService {
  let provider: Promise<SkyService> | undefined;
  // One scale step runs at a time, so a script with many observations at
  // the same time starts one process at a time.
  let scaling: Promise<unknown> = Promise.resolve();
  const scaleInTurn: CaptureScale | undefined =
    scale &&
    ((path, size) => {
      const step = scaling.then(() => scale(path, size));
      scaling = step.catch(() => {});
      return step;
    });
  const apps = new Map<string, AppMarks>();
  // The path of an app for each name that a caller gave for it in an
  // observation.
  const aliases = new Map<string, string>();
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
  // `app` is the selector of an observation of one app.
  const observe = async (request: unknown, app?: string): Promise<unknown> => {
    try {
      return await inner(request);
    } catch (error) {
      let relabeled = relabel(error, false);
      if (
        app !== undefined &&
        relabeled.category === "unknown" &&
        relabeled.code === "unknownError" &&
        error instanceof Error &&
        TIMEOUT_REACHED.test(error.message)
      )
        relabeled = new NativeGuardError(
          relabeled.category,
          `${relabeled.message}${timeLimitNotice(app)}`,
          relabeled.code,
          error,
        );
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
    let epoch = owner();
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
      // An observation of a session viewer passes only when the app list of
      // the native service shows a process of the viewer that runs. The
      // read of the list is a request of its own, and it starts no app.
      // When the read fails, and when the list has another form, the guard
      // knows nothing about the viewer, and the observation passes.
      const viewer = sessionViewer(app);
      if (viewer) {
        let listed: unknown;
        try {
          listed = await observe({ ...request, method: "list_apps", args: [] });
        } catch {
          listed = undefined;
        }
        if (listedAsRunning(listed, viewer.id) === false)
          throw new NativeGuardError("refused", viewerRefusal(viewer.name));
        // Another runtime can take the lease during the read.
        epoch = owner();
      }
      // After an input to a window with no accessibility content, the
      // content gets the settle time before the observation. The guard sends
      // one observation, as for each other window, so the wait asks for no
      // further approval.
      // A caller can name the app by its path, its bundle identifier, or
      // its name, and the entry of the app has the path that the native
      // service returned.
      const known = apps.get(aliases.get(app) ?? app);
      if (known?.pixelOnly && known.inputEnded > 0) {
        const wait = known.inputEnded + timing.settleMs - timing.now();
        if (wait > 0) {
          await timing.sleep(wait);
          // Another runtime can take the lease during the wait. The request
          // needs the lease at the time that the guard forwards it, and the
          // entry of the app gets the epoch of that time.
          epoch = owner();
        }
      }
      const start = ++sequence;
      const observed = await observe(request, app);
      if (!plain(observed) || typeof observed.app !== "string" || !observed.app)
        throw new NativeGuardError(
          "observation",
          "The Sky service returned an observation without an app identity",
        );
      let result: Record<string, unknown> & { app: string } = {
        ...observed,
        app: observed.app,
      };
      const prepared: Prepared =
        plain(result.screenshot) && typeof result.screenshot.url === "string"
          ? await prepare(
              result.screenshot.url,
              scaleInTurn,
              typeof result.text === "string" ? result.text : "",
            )
          : { frame: undefined };
      const frame = prepared.frame;
      // The script receives the screenshot of the guard in place of the
      // screenshot of the native service: an image at the size for the
      // model, or no screenshot.
      if (prepared.screenshot !== undefined)
        result = {
          ...result,
          screenshot:
            prepared.screenshot === null
              ? null
              : {
                  ...(result.screenshot as Record<string, unknown>),
                  ...prepared.screenshot,
                },
        };
      // A text that names no window is a text of changes, so the app keeps
      // the form that its last full text showed.
      const content =
        typeof result.text === "string"
          ? windowContent(result.text)
          : undefined;
      // The path of the app for the name that the caller gave. The map
      // holds a bounded number of names, and the oldest name leaves first.
      aliases.delete(app);
      aliases.set(app, result.app);
      if (aliases.size > ALIAS_LIMIT)
        aliases.delete(aliases.keys().next().value as string);
      const marks = apps.get(result.app);
      if (marks && marks.epoch === epoch) {
        // An observation that started before the last one is older than it,
        // so its screenshot and its form do not replace the newer ones.
        if (start > marks.observed) {
          marks.observed = start;
          marks.frame = frame;
          if (content !== undefined) marks.pixelOnly = content === "pixels";
        }
      } else if (marks) {
        marks.observed = start;
        marks.epoch = epoch;
        marks.frame = frame;
        if (content !== undefined) marks.pixelOnly = content === "pixels";
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
          pixelOnly: content === "pixels",
          inputEnded: 0,
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
      marks.inputEnded = timing.now();
      return result;
    } catch (error) {
      const relabeled = relabel(
        error,
        true,
        pairs.length > 0 || method === "scroll",
      );
      // A refusal of the policy wrapper did not reach the app, so it starts
      // no settle time. Each other failure can change the screen.
      if (!NO_EFFECT.has(relabeled.category)) {
        marks.changed = marks.uncertain = ++sequence;
        marks.inputEnded = timing.now();
      }
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
  guardTiming(),
  captureScale(),
);
