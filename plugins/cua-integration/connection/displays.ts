import { execFile } from "node:child_process";

// The number of pixels for each point of each display, which macOS names the
// backing scale. The native guard permits coordinate input only at the scale
// that the coordinate record covers, and only the launcher can read the
// displays: the guard runs in the trusted worker and starts no process for an
// input.
export type DisplayScales = readonly number[];
// Reads the scale of each display. Undefined means that the scales are
// unknown.
export type DisplayReader = () => Promise<DisplayScales | undefined>;

// How long one read of the displays can take.
export const DISPLAY_READ_TIMEOUT_MS = 5000;

const SIZE = /^(\d+) x (\d+)\b/;
function size(value: unknown): [number, number] | undefined {
  const match = typeof value === "string" ? SIZE.exec(value) : null;
  const width = Number(match?.[1]);
  const height = Number(match?.[2]);
  return width > 0 && height > 0 ? [width, height] : undefined;
}

// The scales in the output of `system_profiler SPDisplaysDataType -json`,
// one for each display, in the order of the output. Each display has a size
// in pixels and a size in points, and its scale is the first over the second.
// The result is undefined when the output is no such report, when it names no
// display, and when one display has no readable scale or a scale that differs
// between its two axes. Thus, one unknown display makes the whole set
// unknown.
export function parseDisplayScales(output: string): DisplayScales | undefined {
  let report: unknown;
  try {
    report = JSON.parse(output);
  } catch {
    return undefined;
  }
  const adapters = (report as { SPDisplaysDataType?: unknown } | null)
    ?.SPDisplaysDataType;
  if (!Array.isArray(adapters)) return undefined;
  const scales: number[] = [];
  for (const adapter of adapters) {
    const displays = (adapter as { spdisplays_ndrvs?: unknown } | null)
      ?.spdisplays_ndrvs;
    // An adapter with no display has no such member.
    if (displays === undefined) continue;
    if (!Array.isArray(displays)) return undefined;
    for (const display of displays) {
      const pixels = size(display?._spdisplays_pixels);
      const points = size(display?._spdisplays_resolution);
      if (!pixels || !points) return undefined;
      const scale = pixels[0] / points[0];
      if (scale !== pixels[1] / points[1]) return undefined;
      scales.push(scale);
    }
  }
  return scales.length > 0 ? scales : undefined;
}

// The macOS system report gives the displays without a permission and
// without a display server connection of this process. A failed command, a
// timeout, and another operating system give unknown scales.
export const displayReader =
  (command = "/usr/sbin/system_profiler"): DisplayReader =>
  () =>
    new Promise((done) =>
      execFile(
        command,
        ["SPDisplaysDataType", "-json"],
        { timeout: DISPLAY_READ_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
        (error, stdout) =>
          done(error ? undefined : parseDisplayScales(String(stdout))),
      ),
    );
export const readDisplayScales = displayReader();
