// The trusted `browser` service handler. The launcher configures this module
// in place of the provider handler, and the runtime's trusted worker loads it.
// Model JavaScript reaches the browser backend only through
// `nodeRepl.rpc("browser", ...)`, so every browser command passes here: the
// cua facade, the browser client, and a raw rpc call alike.
//
// The worker accepts only files under a configured trusted code path and loads
// this file with type stripping. Keep it free of package imports. The lease
// check comes from the native guard, whose directory is also a trusted path.
import { createRequire } from "node:module";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";
import { leaseOwner, type OwnerCheck } from "../native/sky-guard.ts";

export type BrowserService = (request: unknown) => Promise<unknown>;
export type BrowserProvider = {
  handleRpc: BrowserService;
  classifyError?: (error: unknown) => string;
};

// These categories name the origin of a failure, not its severity.
export type BrowserFailureCategory =
  | "refused"
  | "ownership"
  | "approval"
  | "policy"
  | "identity"
  | "freshness"
  | "interruption"
  | "protocol"
  | "unknown";

// The supported provider profile: the Chrome extension backend. The in-app
// browser, Dot, CDP, and MCP Apps backends need host services of the Codex
// app, so the launcher does not enable them and the guard refuses them.
export const SUPPORTED_BROWSER_TYPE = "extension";
export const SUPPORTED_BACKENDS = "chrome";

// API members that the client hides and the provider documentation omits.
// The guard also refuses their commands, because the provider does not check
// this list when it dispatches a command.
export const DISABLED_API_MEMBERS: readonly string[] = [
  "Browser.capabilities",
  "BrowserUser.getTabContext",
  "Tabs.content",
  "Tabs.selected",
  "Tab.capabilities",
  "Tab.clipboard",
  "Tab.content",
  "Tab.cua",
  "Tab.dev",
  "Tab.dom_cua",
  "Tab.requestManualHandoff",
  "Tab.requestUserTakeover",
  "AXAPI.drag",
  "AXAPI.write",
  "PlaywrightAPI.elementInfo",
  "PlaywrightAPI.elementScreenshot",
  "PlaywrightLocator.downloadMedia",
];
// The optional capabilities of the supported profile. Each one passed its
// positive and refusal cases with the Chrome extension. The Codex settings
// and the approvals of the browser service decide each operation (decision
// 0002); the guard adds identity, ownership, and freshness rules only.
// The order is not a priority.
export const SUPPORTED_BROWSER_CAPABILITIES: readonly string[] = [
  "history",
  "fileTransfer",
];
// The optional capabilities outside the profile, and why each one stays
// disabled. The launch diagnostics list them, and the guard refuses their
// commands with the same reason. The order is not a priority.
export const UNSUPPORTED_BROWSER_CAPABILITIES: Readonly<
  Record<string, string>
> = Object.freeze({
  webmcp:
    "WebMCP page tools are unavailable in this integration. A page tool call needs the Codex automatic reviewer, which Claude Code cannot provide. Use the page through its DOM and accessibility tree instead.",
  pageAssets:
    'Page-asset bundles are unavailable in this integration. The browser service writes a bundle to the temporary directory of the runtime, and the read-only sandbox of the runtime refuses that write. Download a file through a link and waitForEvent("download") instead.',
  downloadMedia:
    'Media download is unavailable in this integration, because it timed out with the Chrome extension in the live check. Download a file through a link and waitForEvent("download") instead.',
  cdp: "Raw Chrome DevTools Protocol access is unavailable in this integration. Its commands could pass around the coordinate and read-only rules of this guard. Use the Playwright and accessibility methods instead.",
  browserAuth:
    "Secure sign-in is unavailable in this integration, because it needs the credential form of the ChatGPT app. Ask the user to sign in to the tab in Chrome themselves, then observe the tab again.",
  clipboard: "Clipboard access is outside the supported browser profile.",
  content:
    "Content export and tab context are outside the supported browser profile. Read the page with a DOM snapshot or a locator instead.",
  botDetection:
    "Bot-detection reports are outside the supported browser profile.",
  management:
    "Browser management, viewport, and visibility controls are outside the supported browser profile.",
});
// Optional capabilities that the provider hides when the launcher names them.
export const DISABLED_BROWSER_CAPABILITIES: readonly string[] = [
  "management",
  "viewport",
  "visibility",
];
export const DISABLED_TAB_CAPABILITIES: readonly string[] = [
  "botDetection",
  "browserAuth",
  "cdp",
  "pageAssets",
  "webmcp",
];
// The capability of each command family outside the profile.
const UNSUPPORTED_COMMANDS: ReadonlyArray<[RegExp, string]> = [
  [/^webmcp_/, "webmcp"],
  [/^tab_page_assets_/, "pageAssets"],
  [/download_media/, "downloadMedia"],
  [/^tab_cdp_/, "cdp"],
  [/browser_auth/, "browserAuth"],
  [/clipboard/, "clipboard"],
  [/content|get_tab_context|dev_logs/, "content"],
  [/bot_detection/, "botDetection"],
  [/^browser_(management|viewport|visibility)_/, "management"],
];

// Commands that need no selected browser.
const DISCOVERY = new Set([
  "list_browsers",
  "get_browser",
  "get_default_browser",
  "get_browser_for_url",
  "get_documentation",
  "get_browser_documentation",
]);
// Commands of a selected browser that name no tab.
const BROWSER_COMMANDS = new Set([
  "name_session",
  "list_tabs",
  "create_tab",
  "browser_user_open_tabs",
  "browser_user_history",
]);
// Tab commands that read the page and change nothing.
const READS = new Set([
  "get_tab",
  "tab_screenshot",
  "playwright_dom_snapshot",
  "playwright_evaluate",
  "playwright_locator_all_text_contents",
  "playwright_locator_count",
  "playwright_locator_get_attribute",
  "playwright_locator_inner_text",
  "playwright_locator_is_enabled",
  "playwright_locator_is_visible",
  "playwright_locator_read_all",
  "playwright_locator_text_content",
  "playwright_locator_wait_for",
  "playwright_wait_for_load_state",
  "playwright_wait_for_timeout",
  "playwright_wait_for_url",
  "tab_get_js_dialog",
  // A wait for a download or a file chooser changes no page state. Another
  // command causes the event, so the wait runs beside that input.
  "playwright_wait_for_download",
  "playwright_wait_for_file_chooser",
  "playwright_download_path",
]);
// Tab commands that act on the page through a locator or a dialog. A locator
// resolves its element when it acts, so it needs no fresh element index.
const LOCATOR_INPUTS = new Set([
  "playwright_locator_click",
  "playwright_locator_dblclick",
  "playwright_locator_fill",
  "playwright_locator_press",
  "playwright_locator_press_sequentially",
  "playwright_locator_select_option",
  "playwright_locator_set_checked",
  "tab_handle_js_dialog",
  // A file chooser ID names the input element that opened the chooser.
  "playwright_file_chooser_set_files",
]);
const NAVIGATION = new Set([
  "navigate_tab_url",
  "navigate_tab_back",
  "navigate_tab_forward",
  "navigate_tab_reload",
]);
// The accessibility actions of the reviewed client, and those that need an
// element index.
const AX_ACTIONS = new Set([
  "click",
  "scroll",
  "type_text",
  "paste",
  "press_key",
  "set_value",
  "select_text",
  "perform_secondary_action",
  "drag",
]);
const AX_INDEXED = new Set([
  "click",
  "scroll",
  "set_value",
  "select_text",
  "perform_secondary_action",
]);

export const BROWSER_COORDINATE_REFUSAL =
  "coordinate input has no verified mapping from the image that the model receives to page coordinates in this integration. Use an element index from a current accessibility observation, or a Playwright locator.";

export class BrowserGuardError extends Error {
  readonly category: BrowserFailureCategory;
  readonly reason: string | undefined;
  constructor(
    category: BrowserFailureCategory,
    message: string,
    reason?: string,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "BrowserGuardError";
    this.category = category;
    this.reason = reason;
  }
}

const refuse = (message: string): never => {
  throw new BrowserGuardError("refused", `Browser use refused: ${message}`);
};
const plain = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;
const nonempty = (value: unknown): value is string =>
  typeof value === "string" && value.trim() !== "";
// The provider converts a tab ID to a positive integer, so "07" and "7" name
// one tab. The guard accepts only the canonical form.
const tabId = (value: unknown): value is string =>
  typeof value === "string" && /^[1-9][0-9]{0,15}$/.test(value);

// The provider's gate reasons. A gate refuses before the command runs, so
// these failures establish that the command had no effect.
const APPROVAL_REASONS = new Set([
  "user_declined",
  "approval_cancelled",
  "approval_unavailable",
  "approval_failed_closed",
  "guardian_denied",
  "guardian_timed_out",
]);
const FRESHNESS =
  /Accessibility (element \d+ is stale or missing|element \d+ belongs to a previous page|capture belongs to a previous page)/;

export function classify(error: unknown): {
  category: BrowserFailureCategory;
  reason?: string;
} {
  if (error instanceof BrowserGuardError)
    return error.reason === undefined
      ? { category: error.category }
      : { category: error.category, reason: error.reason };
  if (!(error instanceof Error)) return { category: "unknown" };
  const reason = (error as { reason?: unknown }).reason;
  if (error.name === "AuthorityGateError" && typeof reason === "string")
    return {
      category: APPROVAL_REASONS.has(reason) ? "approval" : "policy",
      reason,
    };
  if (FRESHNESS.test(error.message)) return { category: "freshness" };
  if (/is blocking automation because/.test(error.message))
    return { category: "interruption" };
  return { category: "unknown" };
}

// A gate refusal and a stale element index both stop the command before it
// acts. Every other failure leaves the effect of an input unknown.
const NO_EFFECT = new Set<BrowserFailureCategory>([
  "approval",
  "policy",
  "freshness",
]);

function relabel(error: unknown, input: boolean): BrowserGuardError {
  if (error instanceof BrowserGuardError) return error;
  const { category, reason } = classify(error);
  let message = `${error instanceof Error ? error.message : String(error)} [${category}${reason ? `: ${reason}` : ""}]`;
  // A request that the approval boundary refused reaches the provider as a
  // failed approval. The refusal states why.
  const cause = error instanceof Error ? error.cause : undefined;
  if (reason === "approval_failed_closed" && cause instanceof Error)
    message += ` The approval boundary refused the request: ${cause.message}`;
  if (category === "interruption")
    message +=
      " The user or the extension stopped browser control. Do not repeat the input; ask the user before you continue.";
  else if (category === "freshness")
    message += " Observe the tab again before input by element index.";
  else if (input && !NO_EFFECT.has(category))
    message +=
      " The effect of this command is unknown. Observe the tab before further input; input to this tab stays refused until then.";
  return new BrowserGuardError(category, message, reason, error);
}

// A browser that a get_browser reply described in this runtime.
type BrowserRecord = {
  type: string;
  extensionInstanceId?: string;
  // Whether the backend advertises accessibility observations and input.
  ax: boolean;
  // The user tabs of the latest open-tab inventory. A claim must name one.
  openTabs: Set<string>;
  // The managed tabs of the latest tab list.
  managed: Set<string>;
};
// The guard state of each tab that this runtime created or claimed. Each mark
// is a position in one sequence of guard events, as in the native guard.
type TabRecord = {
  browser: string;
  // Who opened the tab: this runtime ("agent") or the user ("user"). Only an
  // agent tab may be closed by the model; turn cleanup releases a user tab.
  owner: "agent" | "user";
  observed: number;
  // The latest successful observation of any kind: an accessibility state, a
  // screenshot, or a DOM snapshot. It clears an unknown effect, also on a
  // DOM-only tab, but it supplies no element indices.
  checked: number;
  changed: number;
  uncertain: number;
  pending: number;
  epoch: string;
  retention?: "handoff" | "deliverable";
};

// How an input names its target: an element index, the focused element, or
// a locator or URL that the provider resolves when it acts.
type Target = "index" | "focus" | "resolved";

export function createBrowserGuard(
  load: () => Promise<BrowserProvider>,
  owner: OwnerCheck,
  // API members that the launcher disabled in addition to this profile's
  // list. The launcher can disable Tab.ax, which leaves a DOM-only profile.
  extraDisabled: readonly string[] = [],
): { handleRpc: BrowserService; classifyError: (error: unknown) => string } {
  const disabled = new Set([...DISABLED_API_MEMBERS, ...extraDisabled]);
  let provider: Promise<BrowserProvider> | undefined;
  let loaded: BrowserProvider | undefined;
  const browsers = new Map<string, BrowserRecord>();
  const tabs = new Map<string, TabRecord>();
  let sequence = 0;
  const inner = (request: unknown) =>
    (provider ??= load().then((value) => (loaded = value))).then((value) =>
      value.handleRpc(request),
    );
  const key = (browser: string, tab: string) => JSON.stringify([browser, tab]);

  // Runs one command through the provider. A recovery reply that reports a
  // failure reaches the caller unchanged, and the guard state counts it as a
  // failure.
  async function send(
    method: string,
    command: Record<string, unknown>,
    input: boolean,
  ): Promise<{ reply: unknown; value: unknown; failed: boolean }> {
    let reply: unknown;
    try {
      reply = await inner({ method, params: command });
    } catch (error) {
      throw relabel(error, input);
    }
    if (method !== "executeWithRecovery")
      return { reply, value: reply, failed: false };
    return plain(reply) && reply.ok === true
      ? { reply, value: reply.value, failed: false }
      : { reply, value: undefined, failed: true };
  }

  function recordBrowser(id: string, value: unknown) {
    if (!plain(value) || value.id !== id || !nonempty(value.type))
      throw new BrowserGuardError(
        "protocol",
        "The browser service returned a browser without its identity",
      );
    if (value.type !== SUPPORTED_BROWSER_TYPE)
      throw new BrowserGuardError(
        "identity",
        `Browser use refused: the ${value.type} browser provider is not supported. This integration supports only the Chrome extension.`,
      );
    const metadata = plain(value.metadata) ? value.metadata : {};
    const overrides = plain(value.apiSupportOverrides)
      ? value.apiSupportOverrides
      : {};
    const previous = browsers.get(id);
    const extensionInstanceId = nonempty(metadata.extensionInstanceId)
      ? metadata.extensionInstanceId
      : undefined;
    // A browser ID that now names another profile keeps no inventory.
    const same = previous?.extensionInstanceId === extensionInstanceId;
    browsers.set(id, {
      type: value.type,
      ...(extensionInstanceId ? { extensionInstanceId } : {}),
      ax: overrides["Tab.ax"] === true && !disabled.has("Tab.ax"),
      openTabs: same && previous ? previous.openTabs : new Set(),
      managed: same && previous ? previous.managed : new Set(),
    });
    if (!same)
      for (const [name, tab] of tabs) if (tab.browser === id) tabs.delete(name);
    // History and file transfer are API members, not advertised
    // capabilities. Every advertised capability is outside this profile.
    return { ...value, capabilities: { browser: [], tab: [] } };
  }

  // An implicit selection could pick one of several profiles silently.
  async function implicitSelection(
    method: string,
    command: Record<string, unknown>,
  ) {
    const { value: list } = await send(
      method,
      { type: "list_browsers" },
      false,
    );
    if (!Array.isArray(list))
      return refuse(
        "the browser list is unavailable, so no browser can be selected implicitly.",
      );
    const supported = list.filter(
      (entry) => plain(entry) && entry.type === SUPPORTED_BROWSER_TYPE,
    );
    if (supported.length > 1)
      return refuse(
        `${supported.length} Chrome profiles have the extension. Select one explicitly with cua.getBrowser({ extensionInstanceId }).`,
      );
    const { reply, value, failed } = await send(method, command, false);
    if (failed || value === undefined || value === null) return reply;
    if (!plain(value) || !nonempty(value.id))
      throw new BrowserGuardError(
        "protocol",
        "The browser service returned a browser without its identity",
      );
    return shape(method, reply, recordBrowser(value.id, value));
  }
  // Replaces the browser value in a reply, also inside a recovery reply.
  const shape = (method: string, reply: unknown, value: unknown) =>
    method === "executeWithRecovery" ? { ...(reply as object), value } : value;

  function ids(value: unknown): Set<string> {
    const list = Array.isArray(value)
      ? value
      : plain(value) && Array.isArray(value.tabs)
        ? value.tabs
        : [];
    return new Set(
      list
        .filter((entry: unknown) => plain(entry) && tabId(entry.id))
        .map((entry: Record<string, unknown>) => entry.id as string),
    );
  }

  function adopt(browser: string, tab: string, opener: "agent" | "user") {
    const name = key(browser, tab);
    const current = tabs.get(name);
    if (current) return current;
    const record: TabRecord = {
      browser,
      owner: opener,
      observed: 0,
      checked: 0,
      changed: 0,
      uncertain: 0,
      pending: 0,
      epoch: "",
    };
    tabs.set(name, record);
    return record;
  }

  // Applies the freshness rules of an input to one tab, then runs it once.
  async function input(
    method: string,
    command: Record<string, unknown>,
    tab: TabRecord,
    epoch: string,
    target: Target,
    label: string,
  ) {
    if (tab.pending > 0)
      return refuse(
        `another input to tab ${label} has not finished. Await each input before the next one.`,
      );
    if (tab.uncertain > tab.checked)
      return refuse(
        `the effect of an earlier command on tab ${label} is unknown. Observe the tab again before further input.`,
      );
    if (target !== "resolved") {
      if (tab.observed === 0)
        return refuse(
          `accessibility input needs an accessibility observation of tab ${label} in this runtime.`,
        );
      if (tab.epoch !== epoch)
        return refuse(
          `another Claude Code session or agent controlled the desktop after this runtime observed tab ${label}. Observe the tab again before accessibility input.`,
        );
    }
    // Text and keys for the focused element can follow other input.
    if (target === "index" && tab.changed > tab.observed)
      return refuse(
        `the element indices for tab ${label} are from before its last input or navigation. Observe the tab again before input by element index.`,
      );
    tab.pending++;
    try {
      const { reply, failed } = await send(method, command, true);
      tab.changed = ++sequence;
      if (failed) tab.uncertain = tab.changed;
      return reply;
    } catch (error) {
      const relabeled = relabel(error, true);
      if (!NO_EFFECT.has(relabeled.category))
        tab.changed = tab.uncertain = ++sequence;
      throw relabeled;
    } finally {
      tab.pending--;
    }
  }

  async function execute(method: string, command: Record<string, unknown>) {
    const type = command.type;
    if (!nonempty(type)) return refuse("malformed browser command");
    if (
      !DISCOVERY.has(type) &&
      !BROWSER_COMMANDS.has(type) &&
      !READS.has(type) &&
      !LOCATOR_INPUTS.has(type) &&
      !NAVIGATION.has(type) &&
      ![
        "browser_user_claim_tab",
        "close_tab",
        "mark_tab",
        "tab_ax_get_state",
        "tab_ax_action",
      ].includes(type)
    ) {
      if (/^(dom_)?cua_/.test(type)) return refuse(BROWSER_COORDINATE_REFUSAL);
      const capability = UNSUPPORTED_COMMANDS.find(([pattern]) =>
        pattern.test(type),
      )?.[1];
      return refuse(
        capability
          ? `${type}: ${UNSUPPORTED_BROWSER_CAPABILITIES[capability]}`
          : `the browser command ${type} is outside the supported browser profile.`,
      );
    }
    // Every forwarded command needs the lease, also when a grant answers its
    // approval without a dialog.
    const epoch = owner();
    if (type === "get_browser") {
      if (!nonempty(command.id)) return refuse("get_browser requires an id");
      const { reply, value, failed } = await send(method, command, false);
      if (failed) return reply;
      return shape(method, reply, recordBrowser(command.id, value));
    }
    if (type === "get_default_browser" || type === "get_browser_for_url")
      return implicitSelection(method, command);
    if (DISCOVERY.has(type)) return (await send(method, command, false)).reply;

    const browserId = command.browser_id;
    if (!nonempty(browserId)) return refuse(`${type} requires a browser_id`);
    const browser = browsers.get(browserId);
    if (!browser)
      return refuse(
        `select browser ${browserId} with cua.getBrowser() before you use it.`,
      );
    if (BROWSER_COMMANDS.has(type)) {
      const { reply, value, failed } = await send(method, command, false);
      if (failed) return reply;
      if (type === "create_tab") {
        if (!plain(value) || !tabId(value.id))
          throw new BrowserGuardError(
            "protocol",
            "The browser service created a tab without a valid id",
          );
        adopt(browserId, value.id, "agent");
      } else if (type === "browser_user_open_tabs")
        browser.openTabs = ids(value);
      else if (type === "list_tabs") browser.managed = ids(value);
      return reply;
    }

    const tab = command.tab_id;
    if (!tabId(tab)) return refuse(`${type} requires a canonical tab_id`);
    const label = `${tab} of browser ${browserId}`;
    const name = key(browserId, tab);
    if (type === "browser_user_claim_tab") {
      if (!tabs.has(name) && !browser.openTabs.has(tab))
        return refuse(
          `tab ${label} is not in the latest list of user tabs of this browser profile. List the tabs of this browser again and claim one of them.`,
        );
      const { reply, value, failed } = await send(method, command, false);
      if (failed) return reply;
      // The claimed tab can have another runtime ID than the user tab.
      if (!plain(value) || !tabId(value.id))
        throw new BrowserGuardError(
          "protocol",
          "The browser service claimed a tab without a valid id",
        );
      // A tab that this runtime created stays an agent tab.
      adopt(browserId, value.id, "user");
      return reply;
    }
    const record = tabs.get(name);
    if (type === "get_tab" && !record) {
      if (!browser.managed.has(tab))
        return refuse(
          `tab ${label} is neither a tab of this runtime nor in the latest managed tab list. Claim a user tab with cua.getTab().`,
        );
      const { reply, failed } = await send(method, command, false);
      // A managed tab that this runtime did not create stays the user's.
      if (!failed) adopt(browserId, tab, "user");
      return reply;
    }
    if (!record)
      return refuse(
        `tab ${label} was not created or claimed in this runtime. Use cua.createBrowserTab() or cua.getTab() first.`,
      );
    if (type === "close_tab") {
      if (record.owner !== "agent")
        return refuse(
          `tab ${label} belongs to the user. This integration closes only tabs that it created; turn cleanup releases a claimed tab and leaves it open.`,
        );
      const { reply } = await send(method, command, true);
      tabs.delete(name);
      return reply;
    }
    if (type === "mark_tab") {
      if (command.status !== "handoff" && command.status !== "deliverable")
        return refuse("mark_tab requires handoff or deliverable");
      const { reply } = await send(method, command, false);
      record.retention = command.status;
      return reply;
    }
    if (type === "tab_ax_get_state") {
      if (!browser.ax)
        return refuse(
          `tab ${label} has no accessibility support. Use its DOM snapshot and screenshot instead.`,
        );
      const content = command.content;
      if (
        content !== "axState" &&
        content !== "screenshot" &&
        content !== "axStateAndScreenshot"
      )
        return refuse("tab_ax_get_state requires a reviewed content type");
      const start = ++sequence;
      const { reply, value, failed } = await send(method, command, false);
      if (!failed) record.checked = Math.max(record.checked, start);
      // A screenshot alone carries no element indices.
      if (content !== "screenshot" && plain(value) && nonempty(value.state)) {
        if (record.epoch === epoch)
          record.observed = Math.max(record.observed, start);
        else {
          record.observed = start;
          record.epoch = epoch;
        }
      }
      return reply;
    }
    if (type === "tab_ax_action") {
      if (!browser.ax)
        return refuse(
          `tab ${label} has no accessibility support. Use its Playwright locators instead.`,
        );
      const action = command.action;
      if (
        !plain(action) ||
        !nonempty(action.kind) ||
        !AX_ACTIONS.has(action.kind)
      )
        return refuse("tab_ax_action requires a reviewed action");
      if (
        action.kind === "drag" ||
        Array.isArray(action.target) ||
        Object.hasOwn(action, "x") ||
        Object.hasOwn(action, "y")
      )
        return refuse(BROWSER_COORDINATE_REFUSAL);
      const index = AX_INDEXED.has(action.kind)
        ? (action.target ?? action.element_index)
        : action.element_index;
      const valid =
        (Number.isSafeInteger(index) && (index as number) >= 0) ||
        (!AX_INDEXED.has(action.kind) && index === null);
      if (!valid)
        return refuse(
          `${action.kind} requires an element index from a current accessibility observation${AX_INDEXED.has(action.kind) ? "" : ", or null for the focused element"}`,
        );
      return input(
        method,
        command,
        record,
        epoch,
        index === null ? "focus" : "index",
        label,
      );
    }
    if (NAVIGATION.has(type)) {
      if (type === "navigate_tab_url" && !nonempty(command.url))
        return refuse("navigate_tab_url requires a url");
      return input(method, command, record, epoch, "resolved", label);
    }
    if (LOCATOR_INPUTS.has(type))
      return input(method, command, record, epoch, "resolved", label);
    // A read changes nothing, so it needs no freshness. A screenshot or a DOM
    // snapshot clears an unknown effect.
    const start = ++sequence;
    const { reply, failed } = await send(method, command, false);
    if (
      !failed &&
      (type === "tab_screenshot" || type === "playwright_dom_snapshot")
    )
      record.checked = Math.max(record.checked, start);
    return reply;
  }

  const handleRpc: BrowserService = async (request) => {
    if (!plain(request) || !nonempty(request.method))
      return refuse("malformed browser request");
    switch (request.method) {
      case "setup": {
        let value: unknown;
        try {
          value = await inner(request);
        } catch (error) {
          throw relabel(error, false);
        }
        if (!plain(value) || !Array.isArray(value.disabledMemberIds))
          throw new BrowserGuardError(
            "protocol",
            "The browser service did not report its API members",
          );
        return {
          ...value,
          disabledMemberIds: [
            ...new Set([...value.disabledMemberIds, ...DISABLED_API_MEMBERS]),
          ],
        };
      }
      case "execute":
      case "executeWithRecovery":
        if (!plain(request.params)) return refuse("malformed browser command");
        return execute(request.method, request.params);
      default:
        return refuse(
          `the browser request is not available: ${String(request.method)}`,
        );
    }
  };
  // The worker asks for an error kind after a failure. A guard refusal has no
  // provider kind.
  const classifyError = (error: unknown): string => {
    const original =
      error instanceof BrowserGuardError && error.cause !== undefined
        ? error.cause
        : error;
    if (error instanceof BrowserGuardError && original === error)
      return "browser_error";
    try {
      return loaded?.classifyError?.(original) ?? "browser_error";
    } catch {
      return "browser_error";
    }
  };
  return { handleRpc, classifyError };
}

// The worker resolves the provider handler from the declared module
// directories, as it resolves a configured package name.
async function loadProvider(): Promise<BrowserProvider> {
  for (const directory of (process.env.NODE_REPL_NODE_MODULE_DIRS ?? "")
    .split(delimiter)
    .filter(Boolean)) {
    let resolved: string;
    try {
      resolved = createRequire(join(directory, "browser-guard.js")).resolve(
        "@oai/browser-desktop/service",
      );
    } catch {
      continue;
    }
    const providerUrl = pathToFileURL(resolved).href;
    const module = await import(providerUrl);
    if (typeof module.handleRpc !== "function")
      throw new BrowserGuardError(
        "protocol",
        "The reviewed browser service does not export handleRpc",
      );
    return {
      handleRpc: module.handleRpc,
      ...(typeof module.classifyError === "function"
        ? { classifyError: module.classifyError }
        : {}),
    };
  }
  throw new BrowserGuardError(
    "protocol",
    "The reviewed browser service is unavailable",
  );
}

const guard = createBrowserGuard(
  loadProvider,
  leaseOwner(),
  (process.env.BROWSER_USE_DISABLE_API_MEMBERS ?? "")
    .split(",")
    .map((member) => member.trim())
    .filter(Boolean),
);
export const handleRpc = guard.handleRpc;
export const classifyError = guard.classifyError;
