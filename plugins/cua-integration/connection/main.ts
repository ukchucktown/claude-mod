import { LauncherControl } from "./control.ts";
import { discoverRuntime } from "./launch.ts";
import { SessionGrants } from "../policy/grants.ts";
import { ResourceOwnership } from "./ownership.ts";
import { nonempty } from "./protocol.ts";
import { serve } from "./server.ts";
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
  const server = serve(process.stdin, process.stdout, {
    sessionId,
    control,
    createSupervisor(onPending) {
      const spec = discoverRuntime({
        ...(process.env.CUA_PLUGIN_VERSION
          ? { version: process.env.CUA_PLUGIN_VERSION }
          : {}),
        ...(process.env.CUA_SURFACES
          ? { surfaces: process.env.CUA_SURFACES }
          : {}),
      });
      return RuntimeSupervisor.launch(spec, {
        sessionId,
        onPending,
        beforeDispatch: () => control.assertEnabled(),
        grants,
        ownership,
      });
    },
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
