import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolResult } from "../contracts.ts";
import { ConnectionError, object, nonempty } from "../connection/protocol.ts";
import {
  imageSize,
  modelImageSize,
  referencedImage,
  type CaptureReference,
  type PixelSize,
} from "../native/sky-guard.ts";

// nodeRepl.emitImage accepts PNG, JPEG, and WebP bytes, so a model can emit
// each of them. Native screenshots in the feasibility runs were PNG.
export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
export type ImageType = (typeof IMAGE_TYPES)[number];
export type ImageRecord = Readonly<{
  contentIndex: number;
  mimeType: ImageType;
  encoding: "base64";
  bytes: number;
  sha256: string;
  sourcePixels: PixelSize;
  // The size at which the launcher delivers the image. It differs from the
  // source size only for an image above the limits of `modelImageSize`.
  modelPixels: PixelSize;
}>;

function base64(value: unknown, allowEmpty = false): Buffer {
  if (
    typeof value !== "string" ||
    (!allowEmpty && value.length === 0) ||
    value.length % 4 !== 0 ||
    // A repeated group here exhausts the regexp stack on multi-megabyte
    // payloads. The character check is stack-safe, and the re-encoding
    // comparison below rejects misplaced padding and nonzero padding bits.
    !/^[A-Za-z0-9+/]*={0,2}$/.test(value)
  )
    throw new Error("Malformed media base64");
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value)
    throw new Error("Noncanonical media base64");
  return bytes;
}

// The initial native profile has observed PNG output only. Validate its envelope
// and IHDR dimensions; this is not a full raster decoder or proof of screen scale.
function png(bytes: Buffer): { width: number; height: number } {
  if (
    bytes.length < 45 ||
    !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    throw new Error("Malformed PNG signature");
  let width = 0,
    height = 0,
    offset = 8,
    data = false,
    end = false;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    if (length > bytes.length - offset - 12)
      throw new Error("Truncated PNG chunk");
    let crc = 0xffffffff;
    for (const byte of bytes.subarray(offset + 4, offset + 8 + length)) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++)
        crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    if ((crc ^ 0xffffffff) >>> 0 !== bytes.readUInt32BE(offset + 8 + length))
      throw new Error("Invalid PNG chunk checksum");
    if (offset === 8) {
      if (type !== "IHDR" || length !== 13)
        throw new Error("Missing PNG header");
      width = bytes.readUInt32BE(offset + 8);
      height = bytes.readUInt32BE(offset + 12);
      if (!width || !height || width > 0x7fffffff || height > 0x7fffffff)
        throw new Error("Invalid PNG dimensions");
    } else if (type === "IHDR") throw new Error("Duplicate PNG header");
    if (type === "IDAT" && length > 0) data = true;
    offset += length + 12;
    if (type === "IEND") {
      if (length !== 0 || !data || offset !== bytes.length)
        throw new Error("Malformed PNG end");
      end = true;
      break;
    }
  }
  if (!end) throw new Error("Missing PNG data or end");
  return { width, height };
}

// Validate the JPEG marker structure up to the frame header and the end marker.
// This reads dimensions; it does not decode the entropy-coded data.
function jpeg(bytes: Buffer): { width: number; height: number } {
  if (
    bytes.length < 4 ||
    bytes[0] !== 0xff ||
    bytes[1] !== 0xd8 ||
    bytes[bytes.length - 2] !== 0xff ||
    bytes[bytes.length - 1] !== 0xd9
  )
    throw new Error("Malformed JPEG start or end marker");
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) throw new Error("Malformed JPEG marker");
    const marker = bytes[offset + 1]!;
    if (marker === 0xff) {
      offset += 1; // Fill byte.
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) break; // End of image, or start of scan before a frame header.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2; // Marker without a length.
      continue;
    }
    const length = bytes.readUInt16BE(offset + 2);
    if (length < 2 || offset + 2 + length > bytes.length)
      throw new Error("Truncated JPEG segment");
    const frame =
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc;
    if (frame) {
      if (length < 8) throw new Error("Truncated JPEG frame header");
      const height = bytes.readUInt16BE(offset + 5);
      const width = bytes.readUInt16BE(offset + 7);
      if (!width || !height) throw new Error("Invalid JPEG dimensions");
      return { width, height };
    }
    offset += 2 + length;
  }
  throw new Error("Missing JPEG frame header");
}

// Validate the RIFF container and read the canvas size from the first chunk.
function webp(bytes: Buffer): { width: number; height: number } {
  if (
    bytes.length < 30 ||
    bytes.toString("ascii", 0, 4) !== "RIFF" ||
    bytes.toString("ascii", 8, 12) !== "WEBP" ||
    bytes.readUInt32LE(4) + 8 !== bytes.length
  )
    throw new Error("Malformed WebP container");
  const chunk = bytes.toString("ascii", 12, 16);
  const size = bytes.readUInt32LE(16);
  const data = 20;
  if (data + size > bytes.length) throw new Error("Truncated WebP chunk");
  let width = 0,
    height = 0;
  if (chunk === "VP8 ") {
    if (
      size < 10 ||
      bytes[data + 3] !== 0x9d ||
      bytes[data + 4] !== 0x01 ||
      bytes[data + 5] !== 0x2a
    )
      throw new Error("Malformed WebP VP8 frame");
    width = bytes.readUInt16LE(data + 6) & 0x3fff;
    height = bytes.readUInt16LE(data + 8) & 0x3fff;
  } else if (chunk === "VP8L") {
    if (size < 5 || bytes[data] !== 0x2f)
      throw new Error("Malformed WebP lossless frame");
    const bits = bytes.readUInt32LE(data + 1);
    width = (bits & 0x3fff) + 1;
    height = ((bits >>> 14) & 0x3fff) + 1;
  } else if (chunk === "VP8X") {
    if (size < 10) throw new Error("Malformed WebP extended header");
    width = bytes.readUIntLE(data + 4, 3) + 1;
    height = bytes.readUIntLE(data + 7, 3) + 1;
  } else throw new Error(`Unsupported WebP chunk: ${chunk}`);
  if (!width || !height) throw new Error("Invalid WebP dimensions");
  return { width, height };
}

const DIMENSIONS: Record<
  ImageType,
  (bytes: Buffer) => { width: number; height: number }
> = { "image/png": png, "image/jpeg": jpeg, "image/webp": webp };

function image(
  block: Record<string, unknown>,
  contentIndex: number,
): ImageRecord {
  if (typeof block.data !== "string" || typeof block.mimeType !== "string")
    throw new Error("Malformed media block");
  const mimeType = block.mimeType as ImageType;
  if (!IMAGE_TYPES.includes(mimeType))
    throw new Error(`Unsupported image encoding: ${block.mimeType}`);
  const bytes = base64(block.data);
  const sourcePixels = DIMENSIONS[mimeType](bytes);
  return {
    contentIndex,
    mimeType,
    encoding: "base64",
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    sourcePixels,
    modelPixels: modelImageSize(sourcePixels),
  };
}

export function validateObservationResult(value: unknown): ToolResult {
  // Set once the result envelope is valid; a later failure is in a content block.
  let envelope = false;
  try {
    if (
      !object(value) ||
      !Array.isArray(value.content) ||
      (value.isError !== undefined && typeof value.isError !== "boolean") ||
      (value._meta !== undefined && !object(value._meta))
    )
      throw new Error("Malformed tool result");
    envelope = true;
    for (const [index, block] of value.content.entries()) {
      if (!object(block)) throw new Error("Malformed content block");
      switch (block.type) {
        case "text":
          if (typeof block.text !== "string")
            throw new Error("Malformed text block");
          break;
        case "image":
          image(block, index);
          break;
        case "resource": {
          const resource = block.resource;
          if (
            !object(resource) ||
            !nonempty(resource.uri) ||
            (resource.mimeType !== undefined && !nonempty(resource.mimeType)) ||
            (resource.text !== undefined &&
              typeof resource.text !== "string") ||
            (resource.blob !== undefined &&
              typeof resource.blob !== "string") ||
            (typeof resource.text === "string") ===
              (typeof resource.blob === "string")
          )
            throw new Error("Malformed resource block");
          if (resource.blob !== undefined) base64(resource.blob, true);
          break;
        }
        case "resource_link":
          if (!nonempty(block.uri) || !nonempty(block.name))
            throw new Error("Malformed resource link");
          break;
        default:
          throw new Error(
            `Unsupported observation content kind: ${String(block.type)}`,
          );
      }
    }
    // Do not serialize return values into text, normalize content, reorder blocks,
    // fetch resource links, or invent an image when the provider emits none.
    return value as ToolResult;
  } catch (error) {
    // Preserve earlier observations for diagnosis, never relabel failure as success.
    // A valid result envelope with an unsupported or malformed content block
    // fails its own call ("content"); a malformed envelope is "protocol".
    throw new ConnectionError(
      envelope ? "content" : "protocol",
      error instanceof Error ? error.message : String(error),
      value,
    );
  }
}

export function inspectImages(result: ToolResult): readonly ImageRecord[] {
  validateObservationResult(result);
  return result.content.flatMap((block, index) =>
    block.type === "image" ? [image(block, index)] : [],
  );
}

// Scales an image to an exact pixel size and returns it as a JPEG image.
export type Resample = (bytes: Buffer, size: PixelSize) => Promise<Buffer>;

// The macOS image tool does the scaling, because Node has no image decoder.
// The image is in a directory that only this user can read, for the time of
// the call.
export const scaleWithSips: Resample = async (bytes, { width, height }) => {
  const directory = await mkdtemp(join(tmpdir(), "claude-cua-image-"));
  try {
    const source = join(directory, "source");
    const scaled = join(directory, "scaled.jpg");
    await writeFile(source, bytes, { mode: 0o600 });
    await new Promise<void>((done, fail) =>
      execFile(
        "/usr/bin/sips",
        [
          "--resampleHeightWidth",
          String(height),
          String(width),
          "--setProperty",
          "format",
          "jpeg",
          source,
          "--out",
          scaled,
        ],
        { timeout: 20_000 },
        (error) => (error ? fail(error) : done()),
      ),
    );
    return await readFile(scaled);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

// An image that the launcher delivered, with the bytes and the size of its
// source and the size that the model received. The source of a screenshot
// that the native guard scaled is its capture.
export type DeliveredImage = Readonly<{
  bytes: Buffer;
  sourcePixels: PixelSize;
  modelPixels: PixelSize;
}>;

// Reads the bytes of the capture that a reference names. A capture that the
// launcher cannot read, and a file with another digest, give undefined.
export type CaptureSource = (
  reference: Pick<CaptureReference, "name" | "sha256">,
) => Promise<Buffer | undefined>;

// The name of the folder in which the native service writes each screenshot.
// The folder is in the temporary folder of the user. The capture scale
// record gives the source of the name.
export const CAPTURE_FOLDER = "com.openai.sky.CUAService";
// The largest capture that the launcher reads, in bytes.
const CAPTURE_LIMIT_BYTES = 64 * 1024 * 1024;

// Reads a capture from the screenshot folder of the native service. The
// reference comes from the bytes of an image, which a script of the model
// can write. Thus, the launcher reads only a regular file of this user with
// the name of the reference in that one folder, and only a file whose bytes
// have the digest of the reference. A script can then name only a capture
// whose bytes it knows.
//
// The launcher opens the file one time and does not follow a link. It checks
// the open file and reads from the same file, so a change of the folder
// between the check and the read gives it no other file. It reads the number
// of bytes of the check at most.
export const captureFromFolder =
  (folder: string = join(tmpdir(), CAPTURE_FOLDER)): CaptureSource =>
  async ({ name, sha256 }) => {
    let handle;
    try {
      handle = await open(
        join(folder, name),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      const stat = await handle.stat();
      if (
        !stat.isFile() ||
        stat.uid !== process.getuid?.() ||
        stat.size > CAPTURE_LIMIT_BYTES
      )
        return undefined;
      const bytes = Buffer.alloc(stat.size);
      let filled = 0;
      while (filled < bytes.length) {
        const { bytesRead } = await handle.read(
          bytes,
          filled,
          bytes.length - filled,
          filled,
        );
        if (bytesRead === 0) return undefined;
        filled += bytesRead;
      }
      return createHash("sha256").update(bytes).digest("hex") === sha256
        ? bytes
        : undefined;
    } catch {
      return undefined;
    } finally {
      await handle?.close().catch(() => {});
    }
  };

// Gives each image of a result the size that the model receives without a
// second resize. The native guard relates a coordinate pair to that size, so
// the launcher never delivers a larger image: an image that it cannot scale
// becomes a text block. An image within the limits passes with its bytes
// unchanged.
//
// `delivered` holds the SHA-256 digest of the source bytes of each image that
// stays an image in the result. The native guard permits a coordinate pair
// only for a screenshot with one of these digests, so an image that the
// launcher withheld permits none.
//
// `last` is the last image that stays an image in the result, with its source
// bytes. The region tool cuts a part of those bytes, so the model can read
// that part at the resolution of the source.
//
// The native guard scales the screenshot of a large window before the script
// receives it, and it writes a reference to the capture into the image. Such
// an image is within the limits, so it passes with its bytes unchanged. Its
// digest in `delivered` is the digest of the image without the reference,
// which is the digest that the guard keeps for the screenshot. When it is
// the last image, `captures` reads its capture, and the capture is the
// source of `last`. Thus, the region tool cuts from the capture. A capture
// that the launcher cannot read, and a capture that does not have the size
// for the image, leave the image as its own source.
//
// The reference holds the digest of the image that the guard scaled. An
// image with a reference and with other bytes is no image of the guard: its
// digest is that of its own bytes, and the launcher reads no capture for it.
export async function fitForDelivery(
  result: ToolResult,
  resample: Resample = scaleWithSips,
  captures: CaptureSource = captureFromFolder(),
): Promise<{
  result: ToolResult;
  delivered: string[];
  last?: DeliveredImage;
}> {
  const records = inspectImages(result);
  const delivered: string[] = [];
  let last: DeliveredImage | undefined;
  // The capture reference of the last image, when that image has one.
  let reference: CaptureReference | undefined;
  let content: ToolResult["content"] | undefined;
  for (const {
    contentIndex,
    mimeType,
    sha256,
    sourcePixels,
    modelPixels,
  } of records) {
    const source = Buffer.from(
      result.content[contentIndex]!.data as string,
      "base64",
    );
    if (
      sourcePixels.width === modelPixels.width &&
      sourcePixels.height === modelPixels.height
    ) {
      const scaled =
        mimeType === "image/jpeg" ? referencedImage(source) : undefined;
      delivered.push(scaled?.sha256 ?? sha256);
      last = { bytes: source, sourcePixels, modelPixels };
      reference = scaled?.reference;
      continue;
    }
    content ??= [...result.content];
    const block = content[contentIndex]!;
    try {
      const scaled = await resample(source, modelPixels);
      const next = {
        ...block,
        data: scaled.toString("base64"),
        mimeType: "image/jpeg",
      };
      const size = image(next, contentIndex).sourcePixels;
      if (
        size.width !== modelPixels.width ||
        size.height !== modelPixels.height
      )
        throw new Error("The scaled image has another size");
      content[contentIndex] = next;
      delivered.push(sha256);
      last = { bytes: source, sourcePixels, modelPixels };
      // This image is the last image now. An image that the launcher
      // withholds does not replace the last image, so that image keeps its
      // reference.
      reference = undefined;
    } catch {
      content[contentIndex] = {
        type: "text",
        text: `The launcher withheld an image of ${sourcePixels.width} by ${sourcePixels.height} pixels, because it could not scale the image to ${modelPixels.width} by ${modelPixels.height} pixels. No coordinate pair refers to this image.`,
      };
    }
  }
  if (last && reference) {
    const capture = await captures(reference).catch(() => undefined);
    const size = capture && imageSize(capture);
    const fit = size && modelImageSize(size);
    if (
      capture &&
      size &&
      fit?.width === last.modelPixels.width &&
      fit.height === last.modelPixels.height
    )
      last = {
        bytes: capture,
        sourcePixels: size,
        modelPixels: last.modelPixels,
      };
  }
  return {
    result: content ? { ...result, content } : result,
    delivered,
    ...(last ? { last } : {}),
  };
}

export async function fitImages(
  result: ToolResult,
  resample: Resample = scaleWithSips,
): Promise<ToolResult> {
  return (await fitForDelivery(result, resample)).result;
}
