import { spawnSync } from "node:child_process";
import {
  accessSync,
  constants,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ConnectionError, nonempty, object } from "./protocol.ts";
import { REVIEWED_METHODS } from "../native/sky-guard.ts";
import {
  CodexHost,
  type HostedServer,
  type RuntimeHost,
} from "./codex-host.ts";
import { INPUT_SCHEMAS, validateTools, type Tool } from "./tool-contracts.ts";

export type { HostSession, RuntimeHost } from "./codex-host.ts";
export type LaunchSpec = Readonly<{
  // The Codex CLI that hosts the runtime (decision 0003), and the complete
  // environment of that process, without its Codex home.
  codex: Readonly<{
    command: string;
    version: string;
    env: Readonly<Record<string, string>>;
  }>;
  // The `cua_repl` server that the Codex host starts: the declared command
  // and the checked environment, with the native guard of this integration.
  server: HostedServer;
  // The server instructions that the configuration declares for the model.
  // The Codex host does not report the instructions of the runtime.
  instructions?: string;
  diagnostics: {
    configPath: string;
    configSha256: string;
    // The digest of the declared NODE_REPL_TOOL_OVERRIDES text, if any.
    toolOverridesSha256?: string;
    // The tool instructions that `node_repl` receives, if the configuration
    // declares tool overrides.
    toolInstructions?: ToolInstructions;
    pluginVersion: string;
    // The ChatGPT app version that the configuration declares, if any.
    appVersion?: string;
    packages: Record<string, string>;
    // The Codex CLI that hosts the runtime. Its version is also in
    // `packages`, under the name `codex-cli`.
    codexCli: string;
    // Why discovery selected this plugin version.
    selection: VersionSelection;
    review: RuntimeReview;
    nativeGuard: string;
    // The sandbox mode of the thread of the Codex host.
    sandbox: "codex-host-read-only";
  };
}>;
// Where the description of the `js` tool comes from, and the runtime
// surfaces that it describes. The launcher enables the computer surface
// only. The source `provider-sources` means that discovery composed the
// description for that surface from the instruction files of the installed
// `@oai/cua-repl` package. The source `declaration` means that the declared
// description passes without a change. Its surfaces then name more than the
// computer surface when discovery could not compose the text.
export type ToolInstructions = {
  source: "declaration" | "provider-sources";
  surfaces: readonly string[];
};
// An explicit selection names a version. The app configuration is the plugin
// manifest of the ChatGPT app. Without both, discovery takes the newest
// installed version that passes each check.
export type VersionSelection =
  | "explicit"
  | "app-configuration"
  | "newest-compatible";
// The review state of the selected runtime packages and of the Codex CLI. In
// the mode `compatible-unreviewed`, a version is outside the reviewed list
// and each contract check passed. No maintainer reviewed that version.
export type RuntimeReview = {
  mode: "reviewed" | "compatible-unreviewed";
  // The installed version of each package outside the reviewed list. The
  // Codex CLI has the name `codex-cli`.
  unreviewedPackages: Record<string, string>;
  // The pin setting: `strict` refuses each unreviewed package version.
  pins: RuntimePins;
};
export type RuntimePins = "contracts" | "strict";
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
  runtimePackages: Readonly<Record<string, string>>;
  // The reviewed versions of the Codex CLI that hosts the runtime.
  codexCli: readonly string[];
  liveRecords: ReadonlyArray<{
    record: string;
    result: string;
    host: string;
    clientVersion: string;
    runtimePluginVersion: string;
    // The ChatGPT app version, when the record names it.
    appVersion?: string;
    packages?: Readonly<Record<string, string>>;
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
// The environment entries that a runtime configuration can declare. An entry
// with a contract has a reviewed value or a reviewed structure, and
// discovery refuses a configuration that differs. Each other entry passes
// with its declared value.
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
  "CUA_REPL_ENABLED_SURFACES",
  "NODE_REPL_JS_BANNER",
  "NODE_REPL_JS_COMPLETION_SUMMARY",
  "NODE_REPL_TOOL_OVERRIDES",
  "NODE_REPL_UNTRUSTED_ENV_ALLOWLIST",
]);
// The handler of the native service in the declared service map.
const SKY_SERVICE = "@oai/sky/service";
// The service map that the installed configuration declares. Discovery
// refuses each other entry. The runtime receives the `sky` entry only, with
// the native guard as its handler, so the declared `browser` entry starts
// no service.
const DECLARED_SERVICES: Readonly<Record<string, string>> = {
  sky: SKY_SERVICE,
  browser: "@oai/browser-desktop/service",
};
// The bootstrap JavaScript that `node_repl` runs in each new kernel.
const REVIEWED_BANNER = 'await import("@oai/cua/tinyskyAlt");';
// The names of the launcher variables that model JavaScript can read through
// `nodeRepl.env`. The banner import reads the enabled surfaces from there.
const REVIEWED_UNTRUSTED_ENV = new Set([
  "CUA_REPL_ENABLED_SURFACES",
  "CUA_REPL_BROWSER_ENV",
]);
function parsed(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}
const strings = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.entries(value).every(
    ([key, item]) => keys.includes(key) && typeof item === "string",
  );
// Each function returns how the declared value differs from its contract, or
// undefined for a value that agrees.
const ENV_CONTRACTS: Readonly<
  Record<string, (value: string) => string | undefined>
> = {
  NODE_REPL_JS_BANNER: (value) =>
    value.trim() === REVIEWED_BANNER
      ? undefined
      : "the bootstrap JavaScript differs from the reviewed text",
  NODE_REPL_UNTRUSTED_ENV_ALLOWLIST: (value) => {
    // An empty list lets model JavaScript read no variable.
    const names =
      value.trim() === "" ? [] : value.split(",").map((item) => item.trim());
    const name = names.find((item) => !REVIEWED_UNTRUSTED_ENV.has(item));
    return name === undefined
      ? undefined
      : `model JavaScript would read the unreviewed variable ${name || "with an empty name"}`;
  },
  // The text of the instructions can change. The structure cannot: an
  // override can describe a reviewed tool and its reviewed arguments, and it
  // cannot omit a tool or add one.
  NODE_REPL_TOOL_OVERRIDES: (value) => {
    const overrides = parsed(value);
    if (!object(overrides)) return "the value is not a JSON object";
    for (const key of Object.keys(overrides))
      if (!["server_instructions", "tools"].includes(key))
        return `unreviewed member ${key}`;
    if (
      overrides.server_instructions !== undefined &&
      typeof overrides.server_instructions !== "string"
    )
      return "server_instructions is not a string";
    if (overrides.tools === undefined) return undefined;
    if (!object(overrides.tools)) return "tools is not an object";
    for (const [tool, override] of Object.entries(overrides.tools)) {
      if (!Object.hasOwn(INPUT_SCHEMAS, tool))
        return `override of the unreviewed tool ${tool}`;
      if (!object(override)) return `the override of ${tool} is not an object`;
      for (const [key, item] of Object.entries(override)) {
        if (key === "description" && typeof item === "string") continue;
        if (
          key === "field_descriptions" &&
          object(item) &&
          strings(
            item,
            Object.keys(
              INPUT_SCHEMAS[tool as keyof typeof INPUT_SCHEMAS].properties,
            ),
          )
        )
          continue;
        return `unreviewed member ${key} in the override of ${tool}`;
      }
    }
    return undefined;
  },
  NODE_REPL_JS_COMPLETION_SUMMARY: (value) => {
    const summary = parsed(value);
    return object(summary) && strings(summary, ["instructions", "description"])
      ? undefined
      : "the value is not an object with instructions and description text";
  },
};
// The instruction files of the `@oai/cua-repl` package for macOS, by their
// role in the description of the `js` tool. The provider launcher joins the
// description from these files for the surfaces that it enables: the common
// text, then the text of each enabled surface or the text that names a
// surface as disabled, and then the output text.
const INSTRUCTION_FILES = {
  description: "macos/description.md",
  browser: "macos/browser.md",
  browserDisabled: "browser-disabled.md",
  computer: "macos/computer.md",
  computerDisabled: "computer-disabled.md",
  output: "macos/output.md",
} as const;
const surfaceSet = (value: string): string[] =>
  [
    ...new Set(
      value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ].sort();
// The one runtime surface that the launcher enables. The runtime reads the
// enabled surfaces from CUA_REPL_ENABLED_SURFACES.
const ENABLED_SURFACES: readonly string[] = ["computer"];
// The launcher had the setting CUA_SURFACES while it offered a second
// surface, which reached the Chrome extension of the ChatGPT app. That
// surface is gone, and the setting with it. A value that names another
// surface than the computer surface refuses, so that the user learns of the
// removal.
function refuseRemovedSurfaces(value: string | undefined): void {
  const others = surfaceSet(value ?? "").filter(
    (surface) => !ENABLED_SURFACES.includes(surface),
  );
  if (others.length > 0)
    fail(
      `CUA_SURFACES names ${others.join(", ")}, and the launcher has the computer surface only. This integration removed the browser surface and controls a browser as a native app. Remove CUA_SURFACES from the environment.`,
    );
}
// The declared configuration describes the surfaces that the ChatGPT app
// enables, which are the browser and the computer. The launcher enables the
// computer surface only. Then the declared description of the `js` tool
// names entry points that the launcher does not have (issue #58).
//
// This function returns the tool overrides for the computer surface. Each
// sentence of the result is provider text: the function reads the
// instruction files of the installed package and joins them as the provider
// launcher does. It first joins the files for the declared surfaces. Only
// when that text is equal to the declared description does it know the
// composition, and only then does it use the composition for the computer
// surface. In each other case the declared text passes without a change,
// and the diagnostics name the surfaces that the text describes.
function profileToolOverrides(
  overrides: Record<string, unknown>,
  declaredSurfaces: string | undefined,
  modules: string,
): { text?: string; instructions: ToolInstructions } {
  const declared = surfaceSet(declaredSurfaces ?? "");
  const unchanged = {
    instructions: { source: "declaration" as const, surfaces: declared },
  };
  if (declared.join() === ENABLED_SURFACES.join()) return unchanged;
  const tools = overrides.tools;
  if (!object(tools) || !object(tools.js)) return unchanged;
  const parts: Record<string, string> = {};
  try {
    for (const [role, file] of Object.entries(INSTRUCTION_FILES))
      parts[role] = readFileSync(
        join(modules, "@oai/cua-repl/instructions", file),
        "utf8",
      ).trimEnd();
  } catch {
    return unchanged;
  }
  const compose = (enabledSurfaces: readonly string[]) =>
    [
      parts.description,
      enabledSurfaces.includes("browser")
        ? parts.browser
        : parts.browserDisabled,
      enabledSurfaces.includes("computer")
        ? parts.computer
        : parts.computerDisabled,
      parts.output,
    ].join("\n\n");
  if (compose(declared) !== tools.js.description) return unchanged;
  return {
    text: JSON.stringify({
      ...overrides,
      tools: {
        ...tools,
        js: { ...tools.js, description: compose(ENABLED_SURFACES) },
      },
    }),
    instructions: { source: "provider-sources", surfaces: ENABLED_SURFACES },
  };
}
// The completion summary asks the model for a `js` call with a
// `completion_summary` argument, which the reviewed `js` schema does not
// have. Discovery accepts the declared entry and does not pass it on.
const ENV_NOT_FORWARDED = new Set(["NODE_REPL_JS_COMPLETION_SUMMARY"]);

// The script of the declared launcher command, as runtime 26.1111.21308
// declares it. It exports one variable with its inherited value, or empty,
// and then runs the executable that follows the name `cua-repl`.
export const REVIEWED_WRAPPER_SCRIPT =
  'export BROWSER_USE_ACCESS_EXECUTOR_ID="${BROWSER_USE_ACCESS_EXECUTOR_ID-}"; exec "$@"';
// The Apple team identifier of OpenAI in a Developer ID signature.
export const OPENAI_TEAM = "2DC432GLL2";
// True when the file or bundle has a valid Developer ID signature of the
// OpenAI team. The requirement checks the Apple certificate chain, so a
// self-signed certificate with the same team identifier fails.
export function signedByOpenAI(path: string): boolean {
  return (
    spawnSync(
      "/usr/bin/codesign",
      [
        "--verify",
        "--strict",
        // A bundle holds nested code, such as the client app of the native
        // service. Without this flag, the check of nested code is shallow.
        "--deep",
        `-R=anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "${OPENAI_TEAM}"`,
        path,
      ],
      { stdio: "ignore" },
    ).status === 0
  );
}
const UNSIGNED = `has no valid code signature of the OpenAI team ${OPENAI_TEAM}`;
// The characters of a package version that the status can show.
const VERSION_TOKEN = /^[0-9A-Za-z.+_-]{1,64}$/;
// The name of the Codex CLI in the package lists of the diagnostics.
export const CODEX_CLI = "codex-cli";
// The search path of the Codex host and of the runtime.
const SEARCH_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
// The version that the Codex CLI reports, or undefined when it reports none.
// Discovery runs the executable only after its signature check passed.
export function codexVersion(path: string): string | undefined {
  const result = spawnSync(path, ["--version"], {
    encoding: "utf8",
    env: { PATH: SEARCH_PATH },
    timeout: 10000,
    stdio: ["ignore", "pipe", "ignore"],
  });
  return result.status === 0
    ? result.stdout.match(/^codex-cli (\S+)\s*$/)?.[1]
    : undefined;
}

export type DiscoveryOptions = {
  pluginRoot?: string;
  version?: string;
  // `strict` keeps the exact package pins. The default is `contracts`.
  pins?: string;
  // The plugin manifest of the ChatGPT app, which names its current runtime
  // version. The default applies only with the default plugin root.
  appManifest?: string;
  // The signature check, so that a test can use a synthetic installation.
  signedByOpenAI?: (path: string) => boolean;
  // The version check of the Codex CLI, for the same purpose.
  codexVersion?: (path: string) => string | undefined;
  baseEnvironment?: NodeJS.ProcessEnv;
};
const DEFAULT_ROOT = () =>
  join(homedir(), ".codex/plugins/cache/openai-bundled/unified-computer-use");
const DEFAULT_APP_MANIFEST = () =>
  join(
    homedir(),
    ".codex/.tmp/bundled-marketplaces/openai-bundled/plugins/unified-computer-use/.codex-plugin/plugin.json",
  );
// The plugin versions in the cache that have a configuration file, oldest
// first. The order follows the numbers in the version, not the text.
export function installedVersions(root: string = DEFAULT_ROOT()): string[] {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return fail(`CUA plugin cache is unavailable: ${root}`);
  }
  return entries
    .filter((entry) => {
      try {
        return statSync(join(root, entry, ".mcp.json")).isFile();
      } catch {
        return false;
      }
    })
    .sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
}
// The runtime version that the ChatGPT app names as its current one, or
// undefined when the manifest is absent or names none.
function appVersion(manifest: string | undefined): string | undefined {
  if (!manifest) return undefined;
  try {
    const value: unknown = JSON.parse(readFileSync(manifest, "utf8"));
    return object(value) && nonempty(value.version) ? value.version : undefined;
  } catch {
    return undefined;
  }
}

// Selects one installed plugin version and checks its configuration.
export function discoverRuntime(options: DiscoveryOptions = {}): LaunchSpec {
  refuseRemovedSurfaces((options.baseEnvironment ?? process.env).CUA_SURFACES);
  const root = options.pluginRoot ?? DEFAULT_ROOT();
  if (!isAbsolute(root)) return fail("Plugin root must be absolute");
  const versions = installedVersions(root);
  if (options.version) {
    if (
      !versions.includes(options.version) ||
      basename(options.version) !== options.version
    )
      return fail("Selected plugin version is not installed");
    return checkConfiguration(root, options.version, "explicit", options);
  }
  const named = appVersion(
    options.appManifest ??
      (options.pluginRoot === undefined ? DEFAULT_APP_MANIFEST() : undefined),
  );
  if (named !== undefined && versions.includes(named))
    return checkConfiguration(root, named, "app-configuration", options);
  if (versions.length === 0)
    return fail(`The CUA plugin cache contains no runtime version: ${root}`);
  // The newest version that passes each check. A folder name proves nothing,
  // so a newer version that fails does not stop an older one that passes.
  // When each version fails, the refusal is that of the newest version.
  let refusal: unknown;
  for (const version of versions.toReversed()) {
    try {
      return checkConfiguration(root, version, "newest-compatible", options);
    } catch (error) {
      refusal ??= error;
    }
  }
  throw refusal;
}

// True when the module text exports the name. Discovery reads the text and
// never runs a runtime module.
function exportsName(text: string, name: string): boolean {
  if (
    new RegExp(
      `export\\s+(?:async\\s+)?(?:function\\*?|const|let|var|class)\\s+${name}\\b`,
    ).test(text)
  )
    return true;
  for (const [, clause] of text.matchAll(/export\s*\{([^}]*)\}/g))
    for (const item of clause!.split(","))
      if (
        item
          .trim()
          .split(/\s+as\s+/)
          .at(-1) === name
      )
        return true;
  return false;
}
// The contract checks for a runtime with a package version outside the
// reviewed list. They cover what the native guard needs from the packages:
// the export that the guard loads, and each reviewed method of the macOS Sky
// client. The other contracts apply to each runtime: discovery checks the
// environment entries and the trusted service map, and the supervisor checks
// the tool schemas against the catalog of the running process.
function checkPackageContracts(resolve: (specifier: string) => string): void {
  const service = resolve(SKY_SERVICE);
  if (!exportsName(readFileSync(service, "utf8"), "handleRpc"))
    unsupported(
      `Changed guard export contract: ${SKY_SERVICE} does not export handleRpc`,
    );
  // The service builds its macOS client in this module, and the method names
  // of the client are the property names there.
  const location = "targets/mac/create_client.js";
  let client: string;
  try {
    client = readFileSync(join(dirname(service), location), "utf8");
  } catch {
    return unsupported(
      `Changed Sky method contract: @oai/sky has no macOS client module at ${location}`,
    );
  }
  for (const method of REVIEWED_METHODS)
    if (!new RegExp(`(?<![\\w$])${method}(?![\\w$])`).test(client))
      unsupported(
        `Changed Sky method contract: the macOS client of @oai/sky lacks the reviewed method ${method}`,
      );
}

function checkConfiguration(
  root: string,
  version: string,
  selection: VersionSelection,
  options: DiscoveryOptions,
): LaunchSpec {
  const setting = options.pins ?? "contracts";
  const pins: RuntimePins =
    setting === "contracts" || setting === "strict"
      ? setting
      : fail(
          "The runtime pin setting CUA_RUNTIME_PINS must be contracts or strict",
        );
  const signed = options.signedByOpenAI ?? signedByOpenAI;
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
  // The launcher form is a contract: `/bin/sh -c` runs the reviewed wrapper
  // script, which starts `node_repl`. The Codex host starts this command, so
  // each difference refuses, and the message names the difference.
  const declared: unknown[] = Array.isArray(server.args) ? server.args : [];
  if (
    server.command !== "/bin/sh" ||
    declared.length !== 4 ||
    declared[0] !== "-c" ||
    declared[2] !== "cua-repl"
  )
    return unsupported(
      "Changed launcher form: expected /bin/sh with the arguments -c, the wrapper script, cua-repl, and the node_repl executable",
    );
  if (declared[1] !== REVIEWED_WRAPPER_SCRIPT)
    return unsupported(
      "Changed launcher form: the wrapper script differs from the reviewed script text",
    );
  const command = path(server.command, "Launcher shell", true);
  const entry = path(declared[3], "Runtime executable", true);
  if (basename(entry) !== "node_repl")
    return unsupported(
      `Changed launcher form: the wrapper starts ${basename(entry)}, not node_repl`,
    );
  if (!object(server.env)) return fail("Missing declared runtime environment");
  // The Codex host and the runtime receive a fixed search path and these
  // entries of the launcher environment, and no other entry of it.
  const inherited: Record<string, string> = { PATH: SEARCH_PATH };
  const base = options.baseEnvironment ?? process.env;
  for (const key of ["HOME", "USER", "LOGNAME", "TMPDIR", "LANG"])
    if (base[key]) inherited[key] = base[key];
  const env: Record<string, string> = { ...inherited };
  for (const [key, value] of Object.entries(server.env)) {
    if (!ENV_KEYS.has(key) || typeof value !== "string" || value.includes("\0"))
      return unsupported(`Unreviewed runtime environment entry: ${key}`);
    const difference = ENV_CONTRACTS[key]?.(value);
    if (difference !== undefined)
      return unsupported(
        `Changed runtime environment contract: ${key}: ${difference}`,
      );
    if (!ENV_NOT_FORWARDED.has(key)) env[key] = value;
  }
  const service = path(
    env.SKY_CUA_SERVICE_PATH,
    "Trusted native service",
    false,
    true,
  );
  if (!signed(service))
    return unsupported(
      `The native service that SKY_CUA_SERVICE_PATH names ${UNSIGNED}: ${service}`,
    );
  for (const key of ["NODE_REPL_NODE_PATH", "CODEX_CLI_PATH"]) {
    // The launcher starts the Codex CLI as the host of the runtime, and
    // `node_repl` starts both executables. The worker that loads the guards
    // runs in the declared Node executable. A configuration that names
    // another executable must not pass.
    const file = path(env[key], key, true);
    if (!signed(file))
      return unsupported(
        `The executable that ${key} names ${UNSIGNED}: ${file}`,
      );
  }
  const modules = path(
    env.NODE_REPL_NODE_MODULE_DIRS,
    "Runtime module directory",
    false,
    true,
  );
  // The runtime directory of the ChatGPT app holds `bin/node_repl` beside
  // `lib/node_modules`.
  // The comparison uses resolved paths, so a link at the expected place
  // that leads to another directory does not pass.
  let inside = false;
  try {
    inside =
      entry === join(dirname(dirname(modules)), "bin", "node_repl") &&
      realpathSync(entry) ===
        join(realpathSync(dirname(dirname(modules))), "bin", "node_repl");
  } catch {
    inside = false;
  }
  if (!inside)
    return unsupported(
      "Changed launcher form: node_repl is outside the runtime directory of the declared packages",
    );
  if (!signed(entry))
    return unsupported(
      `Changed launcher form: the node_repl executable ${UNSIGNED}: ${entry}`,
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
    return unsupported("Changed trusted service contract: invalid service map");
  }
  if (!object(services) || services.sky !== SKY_SERVICE)
    return unsupported(
      "Changed trusted service contract: missing reviewed sky trusted service",
    );
  for (const [name, handler] of Object.entries(services)) {
    if (DECLARED_SERVICES[name] !== handler)
      return unsupported(
        `Changed trusted service contract: unknown trusted service or handler: ${name}`,
      );
  }
  // The runtime receives the sky service only. Do not inherit private host
  // pipes, identity attestations, custom banners, Node flags, or sandbox
  // overrides. The native guard replaces the provider's sky handler and
  // delegates to it, so every native request from the kernel crosses the
  // guard. The worker loads only trusted code, so the guard's own directory
  // joins the trusted paths.
  const nativeGuard = path(
    fileURLToPath(new URL("../native/sky-guard.ts", import.meta.url)),
    "Native guard",
  );
  env.NODE_REPL_TRUSTED_SERVICES = JSON.stringify({ sky: nativeGuard });
  env.NODE_REPL_TRUSTED_CODE_PATHS += delimiter + dirname(nativeGuard);
  env.CUA_REPL_ENABLED_SURFACES = ENABLED_SURFACES.join(",");
  const packages: Record<string, string> = {};
  const unreviewedPackages: Record<string, string> = {};
  for (const [name, expected] of Object.entries(
    COMPATIBILITY.runtimePackages,
  )) {
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
    if (metadata.version !== expected) {
      // The status and the diagnostics show the version, so it holds only
      // the characters of a version token.
      if (
        typeof metadata.version !== "string" ||
        !VERSION_TOKEN.test(metadata.version)
      )
        return unsupported(
          `Unreviewed runtime package: ${name} without a valid version; the reviewed version is ${expected}`,
        );
      if (pins === "strict")
        return unsupported(
          `Unreviewed runtime package: ${name} ${metadata.version}; the reviewed version is ${expected}`,
        );
      unreviewedPackages[name] = metadata.version;
    }
    packages[name] = metadata.version;
  }
  // The Codex CLI is a compatibility item, as a runtime package is. The
  // handshake and each method of the Codex host have a contract check in
  // `codex-host.ts`, for each version.
  const codex = env.CODEX_CLI_PATH!;
  const cliVersion = (options.codexVersion ?? codexVersion)(codex);
  if (cliVersion === undefined || !VERSION_TOKEN.test(cliVersion))
    return unsupported(
      `Unreviewed Codex CLI: ${codex} reports no valid version; the reviewed versions are ${COMPATIBILITY.codexCli.join(", ")}`,
    );
  if (!COMPATIBILITY.codexCli.includes(cliVersion)) {
    if (pins === "strict")
      return unsupported(
        `Unreviewed Codex CLI: ${cliVersion}; the reviewed versions are ${COMPATIBILITY.codexCli.join(", ")}`,
      );
    unreviewedPackages[CODEX_CLI] = cliVersion;
  }
  packages[CODEX_CLI] = cliVersion;
  // The runtime resolves a module from its declared module directory.
  const require = createRequire(join(modules, "launcher.js"));
  const resolve = (specifier: string): string => {
    try {
      return path(require.resolve(specifier), `Required module ${specifier}`);
    } catch {
      return fail(
        `Required trusted runtime module is unavailable: ${specifier}`,
      );
    }
  };
  resolve("@oai/cua/tinyskyAlt");
  const unreviewed = Object.keys(unreviewedPackages).length > 0;
  // The checks run for each version, also a reviewed one, so that a damaged
  // installation refuses and the checks stay exercised.
  checkPackageContracts(resolve);
  // The Codex host does not report the instructions of the runtime server.
  // In runtime 26.1111.21308, they are the `server_instructions` text of the
  // tool overrides, whose structure the environment contract checked.
  const overrides =
    server.env.NODE_REPL_TOOL_OVERRIDES === undefined
      ? undefined
      : parsed(server.env.NODE_REPL_TOOL_OVERRIDES as string);
  const instructions = object(overrides)
    ? overrides.server_instructions
    : undefined;
  // The description of the `js` tool for the computer surface, from the
  // instruction files of the installed package.
  const profiled = object(overrides)
    ? profileToolOverrides(
        overrides,
        server.env.CUA_REPL_ENABLED_SURFACES as string | undefined,
        modules,
      )
    : undefined;
  if (profiled?.text !== undefined)
    env.NODE_REPL_TOOL_OVERRIDES = profiled.text;
  return Object.freeze({
    codex: Object.freeze({
      command: codex,
      version: cliVersion,
      env: Object.freeze(inherited),
    }),
    server: Object.freeze({
      command,
      args: Object.freeze((declared as string[]).slice()),
      env: Object.freeze(env),
    }),
    ...(typeof instructions === "string" ? { instructions } : {}),
    diagnostics: {
      configPath,
      configSha256: createHash("sha256").update(raw).digest("hex"),
      // The override text reaches the model as server instructions and tool
      // descriptions. Discovery checks only its structure, so the digest
      // shows a change of the text.
      ...(server.env.NODE_REPL_TOOL_OVERRIDES !== undefined
        ? {
            toolOverridesSha256: createHash("sha256")
              .update(server.env.NODE_REPL_TOOL_OVERRIDES as string)
              .digest("hex"),
          }
        : {}),
      ...(profiled ? { toolInstructions: profiled.instructions } : {}),
      pluginVersion: version,
      ...(env.BROWSER_USE_CODEX_APP_VERSION
        ? { appVersion: env.BROWSER_USE_CODEX_APP_VERSION }
        : {}),
      packages,
      codexCli: codex,
      selection,
      review: {
        mode: unreviewed
          ? ("compatible-unreviewed" as const)
          : ("reviewed" as const),
        unreviewedPackages,
        pins,
      },
      nativeGuard,
      sandbox: "codex-host-read-only" as const,
    },
  });
}

// The one interface between the launcher and the installed runtime. It finds
// and checks the runtime configuration, it starts the Codex host of one
// caller runtime, and it checks the tool catalog of the running process. The
// launcher supports one runtime: the `cua_repl` server that the ChatGPT app
// installs, hosted by the Codex CLI. No other module reads the runtime
// configuration or starts the Codex host.
export type RuntimeInterface = Readonly<{
  name: string;
  discover(options?: DiscoveryOptions): LaunchSpec;
  installedVersions(root?: string): string[];
  // Starts one Codex host with the checked server. The environment entries
  // name the lease of this runtime for the native guard.
  launch(spec: LaunchSpec, environment?: Record<string, string>): RuntimeHost;
  validateCatalog(value: unknown): Tool[];
}>;
export const RUNTIME: RuntimeInterface = Object.freeze({
  name: "cua_repl",
  discover: discoverRuntime,
  installedVersions,
  launch(spec: LaunchSpec, environment: Record<string, string> = {}) {
    return CodexHost.launch({
      codex: spec.codex.command,
      codexVersion: spec.codex.version,
      name: "cua_repl",
      server: {
        ...spec.server,
        env: { ...spec.server.env, ...environment },
      },
      environment: spec.codex.env,
    });
  },
  // A catalog that differs from the reviewed schemas refuses, and the
  // message names the tool.
  validateCatalog(value: unknown): Tool[] {
    try {
      return validateTools(value);
    } catch (error) {
      if (error instanceof ConnectionError && error.kind === "protocol")
        throw new ConnectionError(
          "protocol",
          `Changed tool schema contract: ${error.message}`,
          error.details,
        );
      throw error;
    }
  },
});
