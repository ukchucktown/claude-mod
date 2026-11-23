// The region tool of the launcher. A screenshot of a large window has more
// pixels than the model receives, because the native guard or the launcher
// scales each image to the limits of `modelImageSize`. This tool cuts a
// rectangle from the source bytes of the last image that the launcher
// delivered, so the model reads that rectangle at the resolution of the
// capture. For a screenshot that the guard scaled, the source is the capture
// file of the native service.
//
// The tool is for reading. It sends no request to an app, and it does not
// change the image that a coordinate pair refers to (decision record 0005).
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolResult } from "../contracts.ts";
import {
  fitForDelivery,
  inspectImages,
  scaleWithSips,
  type DeliveredImage,
  type Resample,
} from "./result.ts";

export const REGION_TOOL = "screenshot_region";

// A rectangle in pixels, from the top left corner of an image.
export type Rectangle = Readonly<{
  x: number;
  y: number;
  width: number;
  height: number;
}>;

// Cuts a rectangle from an image and returns it as a JPEG image. The
// rectangle is in pixels of that image.
export type Crop = (bytes: Buffer, rectangle: Rectangle) => Promise<Buffer>;

// The macOS image tool does the cut, because Node has no image decoder. The
// image is in a directory that only this user can read, for the time of the
// call. The tool takes the height before the width, and the offset from the
// top before the offset from the left.
export const cropWithSips: Crop = async (bytes, { x, y, width, height }) => {
  const directory = await mkdtemp(join(tmpdir(), "claude-cua-region-"));
  try {
    const source = join(directory, "source");
    const cut = join(directory, "region.jpg");
    await writeFile(source, bytes, { mode: 0o600 });
    await new Promise<void>((done, fail) =>
      execFile(
        "/usr/bin/sips",
        [
          "--cropToHeightWidth",
          String(height),
          String(width),
          "--cropOffset",
          String(y),
          String(x),
          "--setProperty",
          "format",
          "jpeg",
          source,
          "--out",
          cut,
        ],
        { timeout: 20_000 },
        (error) => (error ? fail(error) : done()),
      ),
    );
    return await readFile(cut);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

// A refusal by a rule of the tool. The text starts as a refusal of the guard
// does, so the diagnostics give it the category of a refusal by rule.
const refusal = (text: string): ToolResult => ({
  content: [
    { type: "text", text: `Computer Use refused: the region tool ${text}` },
  ],
  isError: true,
});
// A failure of the image tool, which is no refusal by rule.
const failure = (text: string): ToolResult => ({
  content: [{ type: "text", text: `The region tool failed: ${text}` }],
  isError: true,
});
// The refusal for a caller with no delivered screenshot. The server gives it
// also to a caller that has no runtime.
export const noScreenshot = (): ToolResult =>
  refusal(
    "has no screenshot of this caller. Observe an app with a screenshot first.",
  );
// A number with two decimal places at most.
const short = (value: number) => String(Math.round(value * 100) / 100);

// The rectangle of the source image that covers a rectangle of the image for
// the model. Each edge moves outward to a whole source pixel, so the result
// holds each source pixel that the requested rectangle touches.
export function sourceRectangle(
  {
    sourcePixels,
    modelPixels,
  }: Pick<DeliveredImage, "sourcePixels" | "modelPixels">,
  { x, y, width, height }: Rectangle,
): Rectangle {
  const across = sourcePixels.width / modelPixels.width;
  const down = sourcePixels.height / modelPixels.height;
  const left = Math.floor(x * across);
  const top = Math.floor(y * down);
  const right = Math.min(sourcePixels.width, Math.ceil((x + width) * across));
  const bottom = Math.min(sourcePixels.height, Math.ceil((y + height) * down));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

// The result of one call of the region tool. `last` is the last image that
// the launcher delivered to the caller, and `rectangle` is in pixels of that
// image as the model received it. A request that the tool cannot serve gives
// an error result with its reason, and it changes nothing.
export async function regionResult(
  last: DeliveredImage | undefined,
  rectangle: Rectangle,
  crop: Crop = cropWithSips,
  resample: Resample = scaleWithSips,
): Promise<ToolResult> {
  const { x, y, width, height } = rectangle;
  // The schema of the tool gives the same limits. This function also has
  // them, because another module can call it with no schema check.
  if (
    ![x, y, width, height].every(Number.isSafeInteger) ||
    x < 0 ||
    y < 0 ||
    width < 1 ||
    height < 1
  )
    return refusal(
      "takes a rectangle of whole numbers, with x and y from 0 and with a width and a height from 1.",
    );
  if (!last) return noScreenshot();
  const model = last.modelPixels;
  if (x + width > model.width || y + height > model.height)
    return refusal(
      `takes a rectangle in the last screenshot, which has ${model.width} by ${model.height} pixels. The rectangle [${x}, ${y}, ${width}, ${height}] leaves it.`,
    );
  const from = sourceRectangle(last, rectangle);
  let fitted: ToolResult;
  try {
    const cut = await crop(last.bytes, from);
    fitted = (
      await fitForDelivery(
        {
          content: [
            {
              type: "image",
              data: cut.toString("base64"),
              mimeType: "image/jpeg",
            },
          ],
        },
        resample,
        // The cut is no screenshot of the native guard, so it has no capture.
        async () => undefined,
      )
    ).result;
  } catch {
    return failure("the launcher could not cut the region from the image.");
  }
  const [image] = inspectImages(fitted);
  // The launcher withheld the image, because it could not scale it.
  if (!image) return { ...fitted, isError: true };
  const size = image.sourcePixels;
  const across = size.width / width;
  const down = size.height / height;
  return {
    content: [
      {
        type: "text",
        text: `Region [${x}, ${y}, ${width}, ${height}] of the last screenshot that you received, which has ${model.width} by ${model.height} pixels. This image has ${size.width} by ${size.height} pixels: ${short(across)} pixels for each pixel of that screenshot. The region is for reading. A coordinate pair for input stays a pixel of the full screenshot: the point [a, b] of this image is the pixel [${x} + a / ${short(across)}, ${y} + b / ${short(down)}] of that screenshot.`,
      },
      ...fitted.content,
    ],
  };
}
