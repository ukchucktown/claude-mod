import {
  accessSync,
  constants,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ConnectionError, nonempty, object } from "./protocol.ts";
import {
  DISABLED_API_MEMBERS,
  DISABLED_BROWSER_CAPABILITIES,
  DISABLED_TAB_CAPABILITIES,
  SUPPORTED_BACKENDS,
  SUPPORTED_BROWSER_CAPABILITIES,
  UNSUPPORTED_BROWSER_CAPABILITIES,
} from "../browser/browser-guard.ts";
import {
  codexBrowserApprovals,
  type CodexBrowserApprovals,
} from "../policy/codex-browser.ts";

export type LaunchSpec = Readonly<{
  command: string;
  args: readonly string[];
  env: Readonly<Record<string, string>>;
  diagnostics: {
    configPath: string;
    configSha256: string;
    pluginVersion: string;
    // The ChatGPT app version that the configuration declares, if any.
    appVersion?: string;
    packages: Record<string, string>;
    surfaces: readonly string[];
    nativeGuard: string;
    browserGuard?: string;
    browserProfile?: {
      supported: readonly string[];
      unsupported: Readonly<Record<string, string>>;
      // The optional capabilities that the profile enables, and the reason
      // why each other one stays disabled.
      capabilities: {
        supported: readonly string[];
        unsupported: Readonly<Record<string, string>>;
      };
      automaticCodexApprovals: readonly string[];
    };
    sandbox: "provider-default-read-only-no-network";
  };
}>;
// The browser providers that the installed runtime knows and this profile
// does not enable, with the reason for each.
export const UNSUPPORTED_BROWSER_PROVIDERS: Readonly<Record<string, string>> =
  Object.freeze({
    iab: "The in-app browser needs a Codex app thread and its session metadata.",
    mcpapps: "MCP Apps control a side panel of the Codex app.",
    dot: "Dot is not installed in the tested profile and has no acceptance evidence.",
    cdp: "A raw CDP browser has no acceptance evidence in this integration.",
  });
// Why discovery refused a configuration. A missing configuration is an
// absent, unreadable, or invalid item that the user can supply. An
// unsupported version is a well-formed configuration that differs from the
// reviewed profile, for example after a runtime update.
export type ConfigurationProblem =
  | "missing-configuration"
  | "unsupported-version";
const fail = (
  message: string,
  problem: ConfigurationProblem = "missing-configuration",
): never => {
  throw new ConnectionError("configuration", message, { problem });
};
const unsupported = (message: string): never =>
  fail(message, "unsupported-version");
// The reviewed profile ships with the plugin, so discovery and the
// prerequisite check compare the installation with the same versions.
export type Compatibility = {
  adapterVersion: string;
  nodeBaseline: string;
  nodeMajors: { minimum: number; below: number };
  runtimePackages: {
    computer: Readonly<Record<string, string>>;
    browser: Readonly<Record<string, string>>;
  };
  liveRecords: ReadonlyArray<{
    record: string;
    result: string;
    host: string;
    clientVersion: string;
    runtimePluginVersion: string;
    // The ChatGPT app version, when the record names it.
    appVersion?: string;
    packages?: Readonly<Record<string, string>>;
    surfaces: readonly string[];
  }>;
};
export const COMPATIBILITY: Compatibility = JSON.parse(
  readFileSync(new URL("../compatibility.json", import.meta.url), "utf8"),
);
function path(
  value: unknown,
  label: string,
  executable = false,
  directory = false,
): string {
  if (!nonempty(value) || !isAbsolute(value))
    return fail(`${label} must be an absolute path`);
  try {
    if (directory ? !statSync(value).isDirectory() : !statSync(value).isFile())
      return fail(`${label} has the wrong file type: ${value}`);
    accessSync(value, executable ? constants.X_OK : constants.R_OK);
  } catch {
    return fail(`${label} is unavailable: ${value}`);
  }
  return value;
}
const ENV_KEYS = new Set([
  "NODE_REPL_NATIVE_PIPE_CONNECT_TIMEOUT_MS",
  "NODE_REPL_NODE_MODULE_DIRS",
  "NODE_REPL_NODE_PATH",
  "NODE_REPL_TRUSTED_CODE_PATHS",
  "CODEX_HOME",
  "BROWSER_USE_AVAILABLE_BACKENDS",
  "BROWSER_USE_TINYSKY_ENABLED",
  "NODE_REPL_INSTRUCTIONS_USE_CASE_BROWSER",
  "NODE_REPL_INSTRUCTIONS_USE_CASE_CHROME",
  "NODE_REPL_INSTRUCTIONS_USE_CASE_COMPUTER_USE",
  "BROWSER_USE_CODEX_APP_BUILD_FLAVOR",
  "BROWSER_USE_CODEX_APP_VERSION",
  "NODE_REPL_TRUSTED_SERVICES",
  "SKY_CUA_SERVICE_PATH",
  "CODEX_CLI_PATH",
  "CUA_REPL_NODE_REPL_PATH",
  "CUA_REPL_ENABLED_SURFACES",
]);

export function discoverRuntime(
  options: {
    pluginRoot?: string;
    version?: string;
    surfaces?: string;
    baseEnvironment?: NodeJS.ProcessEnv;
  } = {},
): LaunchSpec {
  const root =
    options.pluginRoot ??
    join(homedir(), ".codex/plugins/cache/openai-bundled/unified-computer-use");
  if (!isAbsolute(root)) return fail("Plugin root must be absolute");
  let versions: string[];
  try {
    versions = readdirSync(root).filter((entry) => {
      try {
        return statSync(join(root, entry, ".mcp.json")).isFile();
      } catch {
        return false;
      }
    });
  } catch {
    return fail(`CUA plugin cache is unavailable: ${root}`);
  }
  if (
    options.version &&
    (!versions.includes(options.version) ||
      basename(options.version) !== options.version)
  )
    return fail("Selected plugin version is not installed");
  if (!options.version && versions.length !== 1)
    return fail(
      `Select an installed plugin version explicitly: ${versions.join(", ") || "none"}`,
    );
  const version = options.version ?? versions[0]!;
  const configPath = join(root, version, ".mcp.json");
  const raw = readFileSync(configPath);
  let config: unknown;
  try {
    config = JSON.parse(raw.toString());
  } catch {
    return fail(`Invalid plugin JSON: ${configPath}`);
  }
  if (
    !object(config) ||
    !object(config.mcpServers) ||
    !object(config.mcpServers.cua_repl)
  )
    return fail("Missing cua_repl server configuration");
  const server = config.mcpServers.cua_repl;
  if (server.enabled === false) return fail("CUA server is disabled");
  const command = path(server.command, "Runtime Node executable", true);
  if (!Array.isArray(server.args) || server.args.length !== 1)
    return unsupported(
      "Expected one CUA launcher argument, without Node flags",
    );
  const launcher = path(server.args[0], "CUA launcher");
  if (
    basename(launcher) !== "cua-repl.mjs" ||
    basename(dirname(launcher)) !== "bin"
  )
    return unsupported("Unexpected CUA launcher entry");
  const surfaces = [
    ...new Set(
      (options.surfaces ?? "computer")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];
  if (
    surfaces.length === 0 ||
    surfaces.some((s) => !["computer", "browser"].includes(s))
  )
    return fail("Enabled surfaces must be computer or browser");
  // The browser profile shares the computer profile's native guard, lease,
  // and bootstrap, so it runs beside the computer surface.
  const browser = surfaces.includes("browser");
  if (browser && !surfaces.includes("computer"))
    return fail("The browser surface requires the computer surface");
  if (!object(server.env)) return fail("Missing declared runtime environment");
  const env: Record<string, string> = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" };
  const base = options.baseEnvironment ?? process.env;
  for (const key of ["HOME", "USER", "LOGNAME", "TMPDIR", "LANG"])
    if (base[key]) env[key] = base[key];
  for (const [key, value] of Object.entries(server.env)) {
    if (!ENV_KEYS.has(key) || typeof value !== "string" || value.includes("\0"))
      return unsupported(`Unreviewed runtime environment entry: ${key}`);
    env[key] = value;
  }
  for (const key of [
    "NODE_REPL_NODE_PATH",
    "CUA_REPL_NODE_REPL_PATH",
    "CODEX_CLI_PATH",
  ])
    path(env[key], key, true);
  path(env.SKY_CUA_SERVICE_PATH, "Trusted native service", false, true);
  const modules = path(
    env.NODE_REPL_NODE_MODULE_DIRS,
    "Runtime module directory",
    false,
    true,
  );
  path(env.CODEX_HOME, "Runtime home", false, true);
  if (!env.NODE_REPL_TRUSTED_CODE_PATHS)
    return fail("Missing trusted code paths");
  for (const directory of env.NODE_REPL_TRUSTED_CODE_PATHS.split(":"))
    path(directory, "Trusted code directory", false, true);
  let services: unknown;
  try {
    services = JSON.parse(env.NODE_REPL_TRUSTED_SERVICES ?? "null");
  } catch {
    return unsupported("Invalid trusted service map");
  }
  if (!object(services) || services.sky !== "@oai/sky/service")
    return unsupported("Missing reviewed sky trusted service");
  for (const [name, handler] of Object.entries(services)) {
    if (
      !(
        (name === "sky" && handler === "@oai/sky/service") ||
        (name === "browser" && handler === "@oai/browser-desktop/service")
      )
    )
      return unsupported(`Unknown trusted service or handler: ${name}`);
  }
  // Restrict services to the selected profile. Do not inherit private host pipes,
  // identity attestations, custom banners, Node flags, or sandbox overrides.
  // The native guard replaces the provider's sky handler and delegates to it,
  // so every native request from the kernel crosses the guard. The worker
  // loads only trusted code, so the guard's own directory joins the trusted paths.
  const nativeGuard = path(
    fileURLToPath(new URL("../native/sky-guard.ts", import.meta.url)),
    "Native guard",
  );
  env.NODE_REPL_TRUSTED_SERVICES = JSON.stringify({ sky: nativeGuard });
  env.NODE_REPL_TRUSTED_CODE_PATHS += delimiter + dirname(nativeGuard);
  // The browser guard replaces the provider's browser handler in the same
  // way. It imports the lease check from the native guard directory, which
  // is already trusted. The profile enables only the Chrome extension
  // backend and hides the members and capabilities outside that profile.
  let browserGuard: string | undefined;
  let codexApprovals: CodexBrowserApprovals | undefined;
  if (browser) {
    if (
      !object(services) ||
      services.browser !== "@oai/browser-desktop/service"
    )
      return unsupported("Missing reviewed browser trusted service");
    browserGuard = path(
      fileURLToPath(new URL("../browser/browser-guard.ts", import.meta.url)),
      "Browser guard",
    );
    env.NODE_REPL_TRUSTED_SERVICES = JSON.stringify({
      sky: nativeGuard,
      browser: browserGuard,
    });
    env.NODE_REPL_TRUSTED_CODE_PATHS += delimiter + dirname(browserGuard);
    env.BROWSER_USE_AVAILABLE_BACKENDS = SUPPORTED_BACKENDS;
    env.BROWSER_USE_DISABLE_API_MEMBERS = DISABLED_API_MEMBERS.join(",");
    env.BROWSER_USE_DISABLE_BROWSER_CAPABILITIES =
      DISABLED_BROWSER_CAPABILITIES.join(",");
    env.BROWSER_USE_DISABLE_TAB_CAPABILITIES =
      DISABLED_TAB_CAPABILITIES.join(",");
    // Codex is the authority for its saved site permissions: a setting that
    // grants origins without a prompt sends no request to the approval
    // boundary. The diagnostics name those settings.
    codexApprovals = codexBrowserApprovals(env.CODEX_HOME!);
  }
  env.CUA_REPL_ENABLED_SURFACES = surfaces.join(",");
  const packages: Record<string, string> = {};
  for (const [name, expected] of Object.entries({
    ...COMPATIBILITY.runtimePackages.computer,
    ...(browser ? COMPATIBILITY.runtimePackages.browser : {}),
  })) {
    let metadata: unknown;
    try {
      metadata = JSON.parse(
        readFileSync(join(modules, name, "package.json"), "utf8"),
      );
    } catch {
      return fail(`Missing runtime package: ${name}`);
    }
    if (!object(metadata) || metadata.name !== name)
      return fail(`Invalid runtime package metadata: ${name}`);
    // The installed version, not the name of the cache folder, decides.
    if (metadata.version !== expected)
      return unsupported(
        `Unreviewed runtime package: ${name} ${typeof metadata.version === "string" ? metadata.version : "without a version"}; the reviewed version is ${expected}`,
      );
    packages[name] = metadata.version;
  }
  if (launcher !== join(modules, "@oai/cua-repl/bin/cua-repl.mjs"))
    return unsupported(
      "Launcher does not belong to the declared runtime package",
    );
  const require = createRequire(launcher);
  for (const specifier of [
    "@oai/cua/tinyskyAlt",
    "@oai/sky/service",
    ...(browser ? ["@oai/browser-desktop/service"] : []),
  ]) {
    try {
      path(require.resolve(specifier), `Required module ${specifier}`);
    } catch {
      return fail(
        `Required trusted runtime module is unavailable: ${specifier}`,
      );
    }
  }
  return Object.freeze({
    command,
    args: Object.freeze([launcher]),
    env: Object.freeze(env),
    diagnostics: {
      configPath,
      configSha256: createHash("sha256").update(raw).digest("hex"),
      pluginVersion: version,
      ...(env.BROWSER_USE_CODEX_APP_VERSION
        ? { appVersion: env.BROWSER_USE_CODEX_APP_VERSION }
        : {}),
      packages,
      surfaces,
      nativeGuard,
      ...(browserGuard
        ? {
            browserGuard,
            browserProfile: {
              supported: ["Chrome extension"],
              unsupported: UNSUPPORTED_BROWSER_PROVIDERS,
              capabilities: {
                supported: SUPPORTED_BROWSER_CAPABILITIES,
                unsupported: UNSUPPORTED_BROWSER_CAPABILITIES,
              },
              // The Codex settings that grant sites without a prompt, if any.
              automaticCodexApprovals: codexApprovals?.automatic ?? [],
            },
          }
        : {}),
      sandbox: "provider-default-read-only-no-network" as const,
    },
  });
}
