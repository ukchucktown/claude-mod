import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { basename } from "node:path";
import { signedByOpenAI, type LaunchSpec } from "./launch.ts";
import type { ResourceOwnership } from "./ownership.ts";

// The Computer Use service is the process `SkyComputerUseService` of OpenAI.
// It makes each native request of a runtime, and it draws the agent pointer.
// The pointer stays on the screen while the process lives. The launcher stops
// the process at two events (decision record 0006): when a person runs
// `/cua stop-service`, and when the launcher stops after it ran a call.
// The service starts again at the next native request of a runtime.
export const SERVICE_PROCESS = "SkyComputerUseService";
// How long the launcher waits for the exit of the service after the signal.
export const SERVICE_EXIT_WAIT_MS = 3000;
// How often the launcher reads the process table during that wait.
const SERVICE_EXIT_POLL_MS = 50;

// The result of one attempt to stop the service. The names give what
// occurred, not an order of severity.
// - `stopped`: each signalled process exited.
// - `not-running`: no process of the service ran, so no signal went out.
// - `in-use`: a runtime of a launcher of this user held the lease of the
//   controlled resource or waited for it, so no signal went out.
// - `still-running`: a process did not exit during the wait, or the system
//   refused the signal for it while another process received the signal.
// - `not-signalled`: a check failed, or the system refused the signal for
//   each process, so no process received a signal. The reason names the
//   cause.
export type ServiceStop = {
  at: string;
  outcome:
    | "stopped"
    | "not-running"
    | "in-use"
    | "still-running"
    | "not-signalled";
  // For `stopped`, the processes that received the signal. For
  // `still-running`, the processes that did not exit. For `not-signalled`
  // after a refused signal, the processes that the system refused.
  pids?: number[];
  reason?: string;
  // Why the launcher made the attempt: the command of a person, or the stop
  // of the launcher. The launcher adds it for the status.
  trigger?: "command" | "launcher-stop";
  // The identifier of the request, for an attempt of the command.
  request?: string;
};

// The bundle of the native service of a checked runtime configuration.
export const servicePath = (spec: LaunchSpec): string | undefined =>
  spec.server.env.SKY_CUA_SERVICE_PATH;

// The process table: the identifier, the user, and the executable path of
// each process.
function processTable(): string {
  return execFileSync("/bin/ps", ["-A", "-o", "pid=,uid=,comm="], {
    encoding: "utf8",
    timeout: 5000,
    maxBuffer: 16 * 1024 * 1024,
  });
}
// The processes of this user whose executable has the name of the service
// and is inside the service bundle. A process with that name from another
// path, such as the copy of another product, is not in the result.
export function serviceProcesses(
  bundle: string,
  table: string,
  uid = process.getuid?.(),
): number[] {
  const roots = new Set([bundle]);
  try {
    roots.add(realpathSync(bundle));
  } catch {
    /* The declared path alone decides. */
  }
  const found: number[] = [];
  for (const line of table.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
    if (!match) continue;
    const [, pid, owner, executable] = match;
    if (
      Number(owner) === uid &&
      basename(executable!) === SERVICE_PROCESS &&
      [...roots].some((root) => executable!.startsWith(`${root}/`))
    )
      found.push(Number(pid));
  }
  return found;
}

export type ServiceStopOptions = {
  // Each default is the real operation. A test supplies its own.
  signedByOpenAI?: (path: string) => boolean;
  processTable?: () => string;
  signal?: (pid: number) => void;
  waitMs?: number;
};
// Sends the termination signal to each process of the service in the bundle,
// and waits for the exit. The function obeys these rules:
// - It checks the code signature of the bundle before a signal, as discovery
//   does, and it signals only a process of that bundle.
// - It signals only while no runtime of a launcher of this user holds the
//   lease of the controlled resource or waits for it. The check and the
//   signal run under the lock of the lease record. A waiter joins under the
//   same lock, so no call starts between the check and the signal.
// - It never throws. A service that does not stop is a result, not a failure.
// Each step before the signal is synchronous, so no call of the calling
// launcher starts between the decision of that launcher and the signal.
export async function stopService(
  bundle: string,
  ownership: ResourceOwnership,
  options: ServiceStopOptions = {},
): Promise<ServiceStop> {
  const table = options.processTable ?? processTable;
  const result = (
    outcome: ServiceStop["outcome"],
    extra: Pick<ServiceStop, "pids" | "reason"> = {},
  ): ServiceStop => ({ at: new Date().toISOString(), outcome, ...extra });
  // The processes that received the signal, the processes for which the
  // system refused it, and the reason of the first refusal.
  let attempt:
    | { signalled: number[]; refused: number[]; refusal?: string }
    | undefined;
  try {
    if (serviceProcesses(bundle, table()).length === 0)
      return result("not-running");
    if (!(options.signedByOpenAI ?? signedByOpenAI)(bundle))
      return result("not-signalled", {
        reason:
          "the service bundle has no valid code signature of the OpenAI team",
      });
    attempt = ownership.whenFree(() => {
      // The table is read again under the lock, so a process that exited
      // during the signature check receives no signal.
      const signalled: number[] = [];
      const refused: number[] = [];
      let refusal: string | undefined;
      for (const pid of serviceProcesses(bundle, table()))
        try {
          (options.signal ?? ((id) => process.kill(id, "SIGTERM")))(pid);
          signalled.push(pid);
        } catch (error) {
          // The code ESRCH means that the process exited before the signal.
          // Each other error leaves a process that can still run.
          const code = (error as NodeJS.ErrnoException)?.code;
          if (code === "ESRCH") continue;
          refused.push(pid);
          refusal ??= `the system refused the signal for process ${pid}: ${code ?? (error instanceof Error ? error.message : String(error))}`;
        }
      return {
        signalled,
        refused,
        ...(refusal === undefined ? {} : { refusal }),
      };
    });
  } catch (error) {
    return result("not-signalled", {
      reason: error instanceof Error ? error.message : String(error),
    });
  }
  if (attempt === undefined) return result("in-use");
  const { signalled, refused, refusal } = attempt;
  const reason = refusal === undefined ? {} : { reason: refusal };
  if (signalled.length === 0)
    return refused.length === 0
      ? result("not-running")
      : result("not-signalled", { pids: refused, ...reason });
  const deadline = Date.now() + (options.waitMs ?? SERVICE_EXIT_WAIT_MS);
  for (;;) {
    let remaining: number[];
    try {
      const running = serviceProcesses(bundle, table());
      remaining = signalled.filter((pid) => running.includes(pid));
    } catch {
      remaining = signalled;
    }
    if (remaining.length === 0 && refused.length === 0)
      return result("stopped", { pids: signalled });
    // A refused process stays, so the wait for the other processes ends
    // with the same result at the deadline or when each of them exited.
    if (remaining.length === 0 || Date.now() >= deadline)
      return result("still-running", {
        pids: [...remaining, ...refused],
        ...reason,
      });
    await new Promise((resolve) => setTimeout(resolve, SERVICE_EXIT_POLL_MS));
  }
}
