import { execFile } from "node:child_process";

// The running processes of one app, by process ID, from the first start to
// the last. The native service observes one process of an app, and the
// duplicate process record shows that it is the process that started first.
// Only the launcher can read the processes: the trusted worker of the
// runtime cannot start `ps`, and the list of the running apps is empty
// there.
export type AppProcessReader = (
  app: string,
) => Promise<readonly number[] | undefined>;

// How long each of the two commands of one read can take.
export const PROCESS_READ_TIMEOUT_MS = 5000;

// The JavaScript for Automation that prints the process ID of each running
// app that a selector names. A selector is a bundle identifier, a path of an
// app bundle, or a name of an app. The script reads the list of the running
// apps. It sends no event to an app and reads no window.
const SCRIPT = `ObjC.import("AppKit");
function run(argv) {
  const selector = argv[0];
  const lower = selector.toLowerCase();
  const pids = [];
  const apps = $.NSWorkspace.sharedWorkspace.runningApplications;
  for (let i = 0; i < apps.count; i++) {
    const app = apps.objectAtIndex(i);
    const id = ObjC.unwrap(app.bundleIdentifier);
    const name = ObjC.unwrap(app.localizedName);
    const path = app.bundleURL.isNil() ? undefined : ObjC.unwrap(app.bundleURL.path);
    if (id === selector || path === selector || (name !== undefined && name.toLowerCase() === lower))
      pids.push(app.processIdentifier);
  }
  return JSON.stringify(pids);
}`;

// The process IDs in the output of the script, or undefined for an output
// of another form.
export function parseProcessIds(output: string): number[] | undefined {
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch {
    return undefined;
  }
  return Array.isArray(value) &&
    value.every((pid) => Number.isSafeInteger(pid) && pid > 0)
    ? [...new Set(value as number[])]
    : undefined;
}

// The listed processes in the output of `ps -o pid=,lstart=`, from the
// first start to the last. Two processes of one second keep the order of
// their process IDs. A process that the output does not name, or whose
// start time has another form, is not in the result, because it ended or
// its place in the order is unknown.
export function startOrder(output: string, pids: readonly number[]): number[] {
  const started = new Map<number, number>();
  for (const line of output.split("\n")) {
    const match = /^\s*(\d+)\s+(\S.*)$/.exec(line);
    if (!match) continue;
    const time = Date.parse(match[2]!);
    if (Number.isFinite(time)) started.set(Number(match[1]), time);
  }
  return pids
    .filter((pid) => started.has(pid))
    .sort((a, b) => started.get(a)! - started.get(b)! || a - b);
}

const run = (
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> =>
  new Promise((done) =>
    execFile(
      command,
      args,
      { timeout: PROCESS_READ_TIMEOUT_MS, maxBuffer: 1024 * 1024, env },
      (error, stdout) => done(error ? undefined : String(stdout)),
    ),
  );

// A failed command, a timeout, and another operating system give undefined.
export const appProcessReader =
  (osascript = "/usr/bin/osascript", ps = "/bin/ps"): AppProcessReader =>
  async (app) => {
    const listed = await run(
      osascript,
      ["-l", "JavaScript", "-e", SCRIPT, app],
      {},
    );
    const pids = listed === undefined ? undefined : parseProcessIds(listed);
    if (pids === undefined) return undefined;
    if (pids.length < 2) return pids;
    // The C locale gives the start time in one form for each user.
    const times = await run(ps, ["-o", "pid=,lstart=", "-p", pids.join(",")], {
      LC_ALL: "C",
    });
    return times === undefined ? undefined : startOrder(times, pids);
  };
export const readAppProcesses = appProcessReader();
