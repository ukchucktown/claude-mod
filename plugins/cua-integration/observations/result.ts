import { createHash } from "node:crypto";
import type { ToolResult } from "../contracts.ts";
import { ConnectionError, object, nonempty } from "../connection/protocol.ts";

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
  sourcePixels: { width: number; height: number };
  clientTransform: "unknown";
  inputTransform: "unknown";
  coordinateMapping: "unavailable";
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
  return {
    contentIndex,
    mimeType,
    encoding: "base64",
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    sourcePixels: DIMENSIONS[mimeType](bytes),
    clientTransform: "unknown",
    inputTransform: "unknown",
    coordinateMapping: "unavailable",
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

// Source pixel dimensions alone never establish model or native input geometry.
export function requireCoordinateMapping(_record: ImageRecord): never {
  throw new ConnectionError(
    "state",
    "Coordinate input unavailable: client and native input transforms are unverified",
  );
}
