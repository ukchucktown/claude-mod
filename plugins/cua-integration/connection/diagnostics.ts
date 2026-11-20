import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import type { ToolResult } from "../contracts.ts";
import {
  codexVersion,
  COMPATIBILITY,
  RUNTIME,
  signedByOpenAI,
  type ConfigurationProblem,
  type DiscoveryOptions,
  type LaunchSpec,
  type RuntimeReview,
} from "./launch.ts";
import { checkResults } from "./control.ts";
import {
  nativePermission,
  sameRuntime,
  type CheckResult,
  type NativePermission,
  type RuntimeVersion,
} from "./native-check.ts";
import { ConnectionError, object } from "./protocol.ts";

// The categories name the cause of a failure, not its severity. A missing
// configuration and an unsupported version stop a launch. A failed policy is
// a refusal by rule, and a failed execution happened in or around the runtime.
export type FailureCategory =
  | ConfigurationProblem
  | "failed-policy"
  | "failed-execution";
// The native guard starts each refusal with this prefix. The runtime can put
// an error name before the message.
const GUARD_REFUSAL = /\bComputer Use refused: /;

// The category of an error that stopped an initialization or a call. During
// initialization, a protocol error means that the handshake of the Codex host
// or the tool catalog of the runtime differs from the reviewed contract.
export function failureCategory(
  error: unknown,
  phase: "initialize" | "call" = "call",
): FailureCategory {
  if (error instanceof ConnectionError) {
    if (error.kind === "configuration")
      return object(error.details) &&
        error.details.problem === "unsupported-version"
        ? "unsupported-version"
        : "missing-configuration";
    if (error.kind === "policy") return "failed-policy";
    if (error.kind === "protocol" && phase === "initialize")
      return "unsupported-version";
  }
  return "failed-execution";
}
// The category of a tool error. A guard refusal and a declined approval are
// refusals by rule. Every other tool error is an execution failure.
export function resultCategory(
  result: ToolResult,
  declined = false,
): FailureCategory {
  const refused = result.content.some(
    (block) =>
      block.type === "text" &&
      typeof block.text === "string" &&
      GUARD_REFUSAL.test(block.text),
  );
  return refused || declined ? "failed-policy" : "failed-execution";
}
// Replaces the home directory with "~", so a report names no local account.
export function sanitize(text: string, home = homedir()): string {
  return home && home !== "/" ? text.split(home).join("~") : text;
}

// A live record that agrees with every version that it pins, but pins fewer
// versions than the report knows. The unknown fields name what it lacks. It
// is historical evidence, not an exact match.
export type PartialLiveRecord = { record: string; unknown: string[] };
export type PrerequisiteReport = {
  evidence: "local-prerequisites";
  claim: string;
  outcome: "ready" | ConfigurationProblem;
  reason?: string;
  fingerprint?: string;
  components: {
    adapter: string;
    node: string;
    client: string;
    app?: string;
    runtimePlugin?: string;
    config?: string;
    configSha256?: string;
    toolOverridesSha256?: string;
    // The source of the `js` tool description, and the runtime surfaces
    // that it describes.
    toolInstructions?: LaunchSpec["diagnostics"]["toolInstructions"];
    packages?: Record<string, string>;
    // The Codex CLI that hosts the runtime. Its version is in `packages`.
    codexCli?: string;
    // Why discovery selected this runtime plugin version.
    selection?: LaunchSpec["diagnostics"]["selection"];
  };
  // The review state of the selected runtime packages and of the Codex CLI.
  // The mode `compatible-unreviewed` names each version that no maintainer
  // reviewed and that passed the contract checks.
  runtimeReview?: RuntimeReview;
  // The live records that observed the launcher with these versions.
  // An empty list means that no live check covers this combination exactly.
  liveRecords: string[];
  // The live records that agree with each version that they pin, but lack
  // some versions of the report.
  partialLiveRecords: PartialLiveRecord[];
  node: { outcome: "ready" | "unsupported-version"; reason?: string };
  // Each installed runtime configuration.
  // A folder name alone never makes a candidate ready.
  candidates: Array<{
    pluginVersion: string;
    outcome: "ready" | ConfigurationProblem;
    reason?: string;
    review?: RuntimeReview["mode"];
  }>;
  // The native permission of the selected runtime, from the most recent
  // `/cua check` result that a connected launcher holds for the same runtime
  // version. Without such a result, each capability is unverified.
  nativePermission: NativePermission;
  taskSuccess: "unverified";
};
const CLAIM =
  "Local availability only. A ready outcome is not live acceptance, native permission, or task success. Only a live record with the same versions shows acceptance.";
function attempt(
  options: DiscoveryOptions,
): LaunchSpec | { problem: ConfigurationProblem; reason: string } {
  try {
    return RUNTIME.discover(options);
  } catch (error) {
    const category = failureCategory(error);
    return {
      problem:
        category === "unsupported-version"
          ? "unsupported-version"
          : "missing-configuration",
      reason: sanitize(error instanceof Error ? error.message : String(error)),
    };
  }
}
// Sorts the live records by how they agree with the selected versions. A
// record that differs in one pinned version does not apply. A record is an
// exact match only when it pins each version that the report knows and each
// one agrees. A version that the record or the report lacks stays unknown,
// so the record is partial evidence.
function liveRecords(
  diagnostics: LaunchSpec["diagnostics"],
  clientVersion: string | undefined,
): { exact: string[]; partial: PartialLiveRecord[] } {
  const exact: string[] = [];
  const partial: PartialLiveRecord[] = [];
  for (const record of COMPATIBILITY.liveRecords) {
    const pairs: Array<[string, string | undefined, string | undefined]> = [
      ["client", record.clientVersion, clientVersion],
      ["runtimePlugin", record.runtimePluginVersion, diagnostics.pluginVersion],
      ["app", record.appVersion, diagnostics.appVersion],
    ];
    if (record.packages)
      for (const [name, version] of Object.entries(diagnostics.packages))
        pairs.push([name, record.packages[name], version]);
    if (
      pairs.some(
        ([, pinned, actual]) =>
          pinned !== undefined && actual !== undefined && pinned !== actual,
      )
    )
      continue;
    const unknown = pairs
      .filter(
        ([, pinned, actual]) => pinned === undefined || actual === undefined,
      )
      .map(([field]) => field);
    if (!record.packages) unknown.push("packages");
    if (unknown.length === 0) exact.push(record.record);
    else partial.push({ record: record.record, unknown });
  }
  return { exact, partial };
}
// The version of the Claude Code CLI on the PATH, or why it is unavailable.
// The installation procedure runs this executable, so the prerequisite check
// needs it.
export function claudeVersion(
  run: (
    command: string,
    args: string[],
  ) => { error?: Error; status: number | null; stdout?: string | null } = (
    command,
    args,
  ) => spawnSync(command, args, { encoding: "utf8" }),
): { version: string } | { failure: string } {
  const result = run("claude", ["--version"]);
  if (result.error)
    return {
      failure: `The Claude Code CLI is unavailable: ${(result.error as NodeJS.ErrnoException).code ?? result.error.message}`,
    };
  if (result.status !== 0)
    return {
      failure: `claude --version exited with status ${result.status}`,
    };
  const version = result.stdout?.match(/^(\d+\.\d+\.\d+)/)?.[1];
  return version
    ? { version }
    : { failure: "claude --version printed no version" };
}
// Checks the configuration that the launcher would select, with the same
// discovery code. The report
// contains versions, digests, and paths under "~", and no environment value,
// session identity, or credential.
export function diagnose(
  options: {
    pluginRoot?: string;
    version?: string;
    pins?: string;
    appManifest?: string;
    signedByOpenAI?: (path: string) => boolean;
    codexVersion?: (path: string) => string | undefined;
    clientVersion?: string;
    // Why the Claude Code CLI is unavailable, when the check found that.
    clientFailure?: string;
    nodeVersion?: string;
    baseEnvironment?: NodeJS.ProcessEnv;
    // The results of the native checks that the connected launchers hold.
    checkResults?: () => CheckResult[];
  } = {},
): PrerequisiteReport {
  const signatures = new Map<string, boolean>();
  const cliVersions = new Map<string, string | undefined>();
  const base = {
    ...(options.pluginRoot ? { pluginRoot: options.pluginRoot } : {}),
    ...(options.pins ? { pins: options.pins } : {}),
    ...(options.appManifest ? { appManifest: options.appManifest } : {}),
    // One report makes several discovery attempts, and each attempt checks
    // the same files. The report asks for each signature one time.
    signedByOpenAI: (path: string) => {
      let result = signatures.get(path);
      if (result === undefined) {
        result = (options.signedByOpenAI ?? signedByOpenAI)(path);
        signatures.set(path, result);
      }
      return result;
    },
    // The same applies to the version of the Codex CLI.
    codexVersion: (path: string) => {
      if (!cliVersions.has(path))
        cliVersions.set(path, (options.codexVersion ?? codexVersion)(path));
      return cliVersions.get(path);
    },
    ...(options.baseEnvironment
      ? { baseEnvironment: options.baseEnvironment }
      : {}),
  };
  const nodeVersion = options.nodeVersion ?? process.versions.node;
  const major = Number(nodeVersion.split(".")[0]);
  const { minimum, below } = COMPATIBILITY.nodeMajors;
  const node: PrerequisiteReport["node"] =
    major >= minimum && major < below
      ? { outcome: "ready" }
      : {
          outcome: "unsupported-version",
          reason: `Node ${nodeVersion} is outside the supported majors ${minimum} through ${below - 1}. The tested version is ${COMPATIBILITY.nodeBaseline}.`,
        };
  const selected = attempt({
    ...base,
    ...(options.version ? { version: options.version } : {}),
  });
  let installed: string[] = [];
  try {
    installed = RUNTIME.installedVersions(options.pluginRoot);
  } catch {
    /* The selected attempt reports the missing cache. */
  }
  const candidates = installed.map((pluginVersion) => {
    const result = attempt({ ...base, version: pluginVersion });
    return "problem" in result
      ? { pluginVersion, outcome: result.problem, reason: result.reason }
      : {
          pluginVersion,
          outcome: "ready" as const,
          review: result.diagnostics.review.mode,
        };
  });
  let components: PrerequisiteReport["components"] = {
    adapter: COMPATIBILITY.adapterVersion,
    node: nodeVersion,
    client:
      options.clientVersion ??
      (options.clientFailure !== undefined ? "unavailable" : "unknown"),
  };
  let fingerprint: string | undefined;
  let records: string[] = [];
  let partialRecords: PartialLiveRecord[] = [];
  let runtimeReview: RuntimeReview | undefined;
  let runtimeVersion: RuntimeVersion | undefined;
  if (!("problem" in selected)) {
    const d = selected.diagnostics;
    runtimeVersion = { pluginVersion: d.pluginVersion, packages: d.packages };
    components = {
      ...components,
      ...(d.appVersion ? { app: d.appVersion } : {}),
      runtimePlugin: d.pluginVersion,
      config: sanitize(d.configPath),
      configSha256: d.configSha256,
      ...(d.toolOverridesSha256
        ? { toolOverridesSha256: d.toolOverridesSha256 }
        : {}),
      ...(d.toolInstructions ? { toolInstructions: d.toolInstructions } : {}),
      packages: d.packages,
      codexCli: sanitize(d.codexCli),
      selection: d.selection,
    };
    runtimeReview = d.review;
    // The digest covers the versions and the configuration digest, not the
    // paths, so two machines with the same profile share a fingerprint.
    fingerprint = createHash("sha256")
      .update(
        JSON.stringify([
          components.adapter,
          components.node,
          components.client,
          components.app ?? null,
          components.runtimePlugin,
          components.configSha256,
          Object.entries(d.packages).sort(),
        ]),
      )
      .digest("hex")
      .slice(0, 16);
    const matched = liveRecords(d, options.clientVersion);
    records = matched.exact;
    partialRecords = matched.partial;
  }
  const failed =
    node.outcome !== "ready"
      ? { outcome: node.outcome, reason: node.reason }
      : "problem" in selected
        ? { outcome: selected.problem, reason: selected.reason }
        : options.clientFailure !== undefined
          ? {
              outcome: "missing-configuration" as const,
              reason: options.clientFailure,
            }
          : undefined;
  // A result of the selected runtime version comes first. Otherwise the most
  // recent result shows as a result of another runtime, never as current.
  let results: CheckResult[] = [];
  try {
    results = (options.checkResults ?? checkResults)();
  } catch {
    /* Without a readable result, each capability stays unverified. */
  }
  const lastCheck =
    results.find((result) => sameRuntime(result.runtime, runtimeVersion)) ??
    results[0];
  return {
    evidence: "local-prerequisites",
    claim: CLAIM,
    outcome: failed?.outcome ?? "ready",
    ...(failed?.reason ? { reason: failed.reason } : {}),
    ...(fingerprint ? { fingerprint } : {}),
    components,
    ...(runtimeReview ? { runtimeReview } : {}),
    liveRecords: records,
    partialLiveRecords: partialRecords,
    node,
    candidates,
    nativePermission: nativePermission(lastCheck, runtimeVersion),
    taskSuccess: "unverified",
  };
}

// node diagnostics.ts [--plugin-version VERSION]
// [--runtime-pins contracts|strict] [--client-version VERSION]. The defaults
// follow the launcher environment.
// The exit code is 0 for a ready outcome and 1 otherwise.
function run(argv: string[]): PrerequisiteReport {
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const [flag, value] = [argv[i]!, argv[i + 1]];
    if (
      !["--plugin-version", "--runtime-pins", "--client-version"].includes(
        flag,
      ) ||
      value === undefined
    )
      throw new Error(
        "Usage: diagnostics.ts [--plugin-version VERSION] [--runtime-pins contracts|strict] [--client-version VERSION]",
      );
    flags[flag] = value;
  }
  const version = flags["--plugin-version"] ?? process.env.CUA_PLUGIN_VERSION;
  const pins = flags["--runtime-pins"] ?? process.env.CUA_RUNTIME_PINS;
  const flag = flags["--client-version"];
  const client = flag ? { version: flag } : claudeVersion();
  return diagnose({
    ...(version ? { version } : {}),
    ...(pins ? { pins } : {}),
    ...("version" in client
      ? { clientVersion: client.version }
      : { clientFailure: client.failure }),
  });
}
// A path through a symlink, such as a linked home directory, names the same
// module. An argument that names no file is not this module.
const main = (() => {
  try {
    return (
      !!process.argv[1] &&
      import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
    );
  } catch {
    return false;
  }
})();
if (main) {
  try {
    const report = run(process.argv.slice(2));
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    process.exitCode = report.outcome === "ready" ? 0 : 1;
  } catch (error) {
    process.stderr.write(
      (error instanceof Error ? error.message : "Diagnostics failed") + "\n",
    );
    process.exitCode = 2;
  }
}
