import { readFileSync } from "node:fs";
import { join } from "node:path";

// The browser service reads the Codex browser configuration under the
// runtime's CODEX_HOME. A mode of "never_ask" answers every request of its
// kind without a prompt, and an origin in an allowed list answers the
// requests for that origin. Codex is the authority for those saved
// permissions, so the launcher only reports them in its diagnostics.

export type CodexBrowserApprovals = {
  path: string;
  // The settings that answer a browser request without a prompt. Empty when
  // every origin, download, upload, and history request reaches the approval
  // boundary.
  automatic: string[];
};
// The modes that answer every request of one kind, and the tables whose
// allowed list answers the requests for one origin.
const MODES = [
  "approval_mode",
  "download_approval_mode",
  "upload_approval_mode",
  "history_approval_mode",
];
const ALLOWED: Readonly<Record<string, string>> = {
  origins: "saved allowed origins",
  downloads: "saved allowed download origins",
  uploads: "saved allowed upload origins",
};

// Removes a comment from one line. A # inside a string stays.
function uncomment(line: string): string {
  let quote: string | undefined;
  for (let index = 0; index < line.length; index++) {
    const char = line[index]!;
    if (quote) {
      if (char === "\\" && quote === '"') index++;
      else if (char === quote) quote = undefined;
    } else if (char === '"' || char === "'") quote = char;
    else if (char === "#") return line.slice(0, index);
  }
  return line;
}
const strings = (value: string) => /["'][^"']+["']/.test(value);
const balanced = (value: string) =>
  (value.match(/\[/g)?.length ?? 0) === (value.match(/\]/g)?.length ?? 0) &&
  (value.match(/\{/g)?.length ?? 0) === (value.match(/\}/g)?.length ?? 0);

// Reads the settings from a TOML subset: top-level keys, table headers,
// inline tables, and arrays over several lines. The diagnostics name a file
// that does not fit this subset, because it can hold any setting.
export function codexBrowserApprovals(
  codexHome: string,
): CodexBrowserApprovals {
  const path = join(codexHome, "browser", "config.toml");
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? { path, automatic: [] }
      : { path, automatic: ["an unreadable browser configuration"] };
  }
  const automatic = new Set<string>();
  let table = "";
  let pending = "";
  for (const raw of text.split(/\r?\n/)) {
    pending = pending
      ? `${pending} ${uncomment(raw).trim()}`
      : uncomment(raw).trim();
    if (!pending || !balanced(pending)) continue;
    const entry = pending;
    pending = "";
    const header = entry.match(/^\[\s*([A-Za-z0-9_.-]+)\s*\]$/);
    if (header) {
      table = header[1]!;
      continue;
    }
    if (/^\[\[/.test(entry)) {
      table = entry;
      continue;
    }
    const pair = entry.match(/^([A-Za-z0-9_."-]+)\s*=\s*(.+)$/);
    if (!pair) {
      automatic.add("an unrecognized browser configuration line");
      continue;
    }
    const key = pair[1]!.replaceAll('"', "");
    const value = pair[2]!;
    const name = table ? `${table}.${key}` : key;
    if (MODES.includes(name) && /^["']never_ask["']$/.test(value))
      automatic.add(`${name} = "never_ask"`);
    const [group, field] = name.split(".");
    if (ALLOWED[group!] && field === "allowed" && strings(value))
      automatic.add(ALLOWED[group!]!);
    if (ALLOWED[name] && field === undefined) {
      const allowed = value.match(/allowed\s*=\s*\[([^\]]*)\]/);
      if (allowed && strings(allowed[1]!)) automatic.add(ALLOWED[name]!);
    }
  }
  if (pending) automatic.add("an unterminated browser configuration value");
  return { path, automatic: [...automatic] };
}
