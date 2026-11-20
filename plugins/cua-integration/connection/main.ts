import { LauncherControl } from "./control.ts";
import { RUNTIME } from "./launch.ts";
import { SessionGrants } from "../policy/grants.ts";
import { ResourceOwnership } from "./ownership.ts";
import { nonempty } from "./protocol.ts";
import { serve } from "./server.ts";
import { servicePath, stopService } from "./service.ts";
import { RuntimeSupervisor } from "./supervisor.ts";

const sessionId = process.env.CLAUDE_CODE_SESSION_ID;
if (!nonempty(sessionId)) {
  process.stderr.write(
    "CLAUDE_CODE_SESSION_ID is required; start this launcher through Claude Code.\n",
  );
  process.exitCode = 1;
} else {
  const control = new LauncherControl(sessionId);
  // The runtimes of all callers share the session grants of this launcher
  // and the lease of the one controlled resource.
  const grants = new SessionGrants();
  const ownership = new ResourceOwnership();
  // The service bundle of the runtime that this launcher started last.
  let service: string | undefined;
  const server = serve(process.stdin, process.stdout, {
    sessionId,
    control,
    createSupervisor(onPending) {
      const spec = RUNTIME.discover({
        ...(process.env.CUA_PLUGIN_VERSION
          ? { version: process.env.CUA_PLUGIN_VERSION }
          : {}),
        ...(process.env.CUA_RUNTIME_PINS
          ? { pins: process.env.CUA_RUNTIME_PINS }
          : {}),
      });
      service = servicePath(spec);
      return RuntimeSupervisor.launch(spec, {
        sessionId,
        onPending,
        beforeDispatch: () => control.assertEnabled(),
        grants,
        ownership,
      });
    },
    stopService: async () =>
      service === undefined ? undefined : stopService(service, ownership),
    // A stopped server releases stdin so the process can exit.
    onStopped: () => process.stdin.destroy(),
  });
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
    process.once(signal, () => {
      server.close();
      process.stdin.destroy();
      process.exitCode = 1;
    });
}
