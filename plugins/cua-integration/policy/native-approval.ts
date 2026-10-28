import type { Decision, PendingRequest, ServerRequest } from "../contracts.ts";

const record = (value: unknown): value is Record<string, any> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;
const operations = new Set([
  "get_app_state",
  "click",
  "drag",
  "paste",
  "press_key",
  "scroll",
  "select_text",
  "set_value",
  "type_text",
  "perform_secondary_action",
]);
const metadataKeys = new Set([
  "codex_approval_kind",
  "connector_id",
  "connector_name",
  "persist",
  "riskLevel",
  "subtitle",
  "tool_call_id",
  "tool_name",
  "tool_params",
  "tool_params_display",
  "progressToken",
  "x-codex-turn-metadata",
]);

// The metadata that every request of the reviewed browser service carries,
// and the runtime bridge fields that it adds.
const browserMetadataKeys = [
  "codex_approval_kind",
  "connector_id",
  "connector_name",
  "persist",
  "progressToken",
  "tool_call_id",
  "x-codex-turn-metadata",
];

// Why the boundary refuses a request. The reasons name the cause, not a
// severity: a defect in the request, a question that only the Codex automatic
// reviewer may answer, a question that needs secure input in the ChatGPT app,
// or a capability outside the supported browser profile.
export type ApprovalRefusal =
  | "malformed"
  | "strict_review"
  | "user_input"
  | "unsupported";

export class ApprovalError extends Error {
  readonly reason: ApprovalRefusal;
  constructor(message: string, reason: ApprovalRefusal = "malformed") {
    super(message);
    this.reason = reason;
  }
}

// The scopes of an accept: this request, or the session of the launcher or
// the runtime. No scope outlives the launcher. A lasting permission belongs
// in the Codex app (decision 0002), so the launcher never offers "always".
export type ApprovalScope = "once" | "session";
// The resource kinds of an approval. Each kind authorizes another resource,
// so an answer for one kind never answers a request of another kind. The
// launcher keeps session grants only for apps. The browser service keeps its
// own answers for the browser kinds (decision 0002).
export type ApprovalKind = "app" | "origin" | "history" | "download" | "upload";
export type NativeApproval = {
  kind: ApprovalKind;
  // The canonical resource: a bundle identifier, a browser origin, or
  // "browsing_history".
  appId: string;
  // Presentation only: the app name, or the browser name.
  appName: string;
  operation: string;
  // A browser request carries no risk level of its own, except raw CDP. The
  // launcher records each browser request as high; the dialog omits it.
  riskLevel: "low" | "high";
  // The scopes that the request permits and the launcher may offer.
  scopes: ApprovalScope[];
  // Presentation only: the request facts that the dialog shows beyond the
  // resource, such as the queries of a history request.
  detail?: string;
};

const emptySchema = (schema: unknown) =>
  record(schema) &&
  schema.type === "object" &&
  record(schema.properties) &&
  Object.keys(schema.properties).length === 0 &&
  !Object.keys(schema).some(
    (key) => !["type", "properties", "required"].includes(key),
  ) &&
  (schema.required === undefined ||
    (Array.isArray(schema.required) && schema.required.length === 0));
// An http or https origin in its canonical serialization.
const canonicalOrigin = (value: unknown): value is string => {
  if (!text(value)) return false;
  try {
    const url = new URL(value);
    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      url.origin === value
    );
  } catch {
    return false;
  }
};
const unsupportedBrowser = () =>
  new ApprovalError(
    "Unsupported browser approval contract or required capability",
  );

// The checks that every browser request shares: the elicitation form, the
// browser connector, and no metadata key outside the reviewed set of its
// kind.
function browserRequest(
  request: ServerRequest,
  keys: readonly string[],
): Record<string, any> {
  const params = request.params;
  const meta: unknown = params._meta;
  const allowed = new Set([...browserMetadataKeys, ...keys]);
  if (
    request.method !== "elicitation/create" ||
    params.mode !== "form" ||
    !text(params.message) ||
    !record(meta) ||
    Object.keys(params).some(
      (key) => !["mode", "message", "requestedSchema", "_meta"].includes(key),
    ) ||
    Object.keys(meta).some((key) => !allowed.has(key)) ||
    meta.codex_approval_kind !== "mcp_tool_call" ||
    meta.connector_id !== "browser-use" ||
    !text(meta.connector_name) ||
    (meta.tool_call_id !== undefined && !text(meta.tool_call_id)) ||
    !emptySchema(params.requestedSchema)
  )
    throw unsupportedBrowser();
  return meta;
}

// The service asks for access to the origin of a page before it observes or
// acts on that page, when no Codex permission answers it.
//
// The service keeps a decline of the user for the session of the runtime
// connection. It keeps an accept for that session too, unless the site
// policy accessApprovalLifetime is "turn". The request does not say which
// lifetime applies. Thus, an origin request has no one-time accept: the only
// accept is "session", and the dialog says that an approval usually lasts as
// long as a denial. The launcher keeps no site grant of its own (decision
// 0002).
function originApproval(request: ServerRequest): NativeApproval {
  const meta = browserRequest(request, [
    "codex_request_type",
    "codex_sensitive_action",
    "origin",
    "tool_name",
    "tool_params",
    "tool_params_display",
    "tool_title",
  ]);
  if (
    meta.codex_sensitive_action !== true ||
    (meta.codex_request_type !== undefined &&
      meta.codex_request_type !== "approval_request") ||
    meta.tool_name !== "access_browser_origin" ||
    (meta.tool_title !== undefined && !text(meta.tool_title)) ||
    !record(meta.tool_params) ||
    Object.keys(meta.tool_params).length !== 1 ||
    !canonicalOrigin(meta.tool_params.origin) ||
    meta.origin !== meta.tool_params.origin ||
    !Array.isArray(meta.tool_params_display) ||
    meta.tool_params_display.length !== 0 ||
    (meta.persist !== undefined && meta.persist !== "always")
  )
    throw unsupportedBrowser();
  return {
    kind: "origin",
    appId: meta.tool_params.origin as string,
    appName: meta.connector_name as string,
    operation: "access_browser_origin",
    riskLevel: "high",
    scopes: ["session"],
  };
}

// The service asks before it reads the browsing history, when no Codex
// setting answers it. It keeps an answer only when the reply asks for a
// permanent one, which writes the Codex settings. So a history request has
// only a one-time accept.
function historyApproval(request: ServerRequest): NativeApproval {
  const meta = browserRequest(request, [
    "sensitive_data",
    "subtitle",
    "tool_params",
  ]);
  const params = meta.tool_params;
  if (
    meta.sensitive_data !== "browsing_history" ||
    (meta.persist !== undefined && meta.persist !== "always") ||
    (meta.subtitle !== undefined && !text(meta.subtitle)) ||
    !record(params) ||
    Object.keys(params).some(
      (key) => !["queries", "date_range", "max_results"].includes(key),
    ) ||
    (params.queries !== undefined &&
      (!Array.isArray(params.queries) ||
        params.queries.length === 0 ||
        params.queries.some((query: unknown) => typeof query !== "string"))) ||
    (params.date_range !== undefined && !text(params.date_range)) ||
    !Number.isSafeInteger(params.max_results) ||
    params.max_results < 1
  )
    throw unsupportedBrowser();
  return {
    kind: "history",
    appId: "browsing_history",
    appName: meta.connector_name as string,
    operation: "read_browsing_history",
    riskLevel: "high",
    scopes: ["once"],
    detail: [
      params.queries === undefined
        ? "no search terms"
        : `search terms ${params.queries.map((query: string) => JSON.stringify(query)).join(", ")}`,
      params.date_range ?? "All history",
      `at most ${params.max_results} results`,
    ].join("; "),
  };
}

// The scopes of a file-transfer request. The service keeps a session answer
// for the session of the runtime connection, and keeps no plain accept or
// decline. A permanent answer would write the Codex settings, so the
// launcher never offers it.
function transferScopes(persist: unknown): ApprovalScope[] {
  const list = Array.isArray(persist) ? persist : [persist];
  if (
    list.length === 0 ||
    list.some((scope) => scope !== "session" && scope !== "always") ||
    new Set(list).size !== list.length
  )
    throw unsupportedBrowser();
  return list.includes("session") ? ["once", "session"] : ["once"];
}

// The service asks before a download from an origin or an upload to it, when
// no Codex setting answers it.
function transferApproval(request: ServerRequest): NativeApproval {
  const meta = browserRequest(request, [
    "file_transfer",
    "origin",
    "tool_name",
    "tool_params",
    "tool_title",
  ]);
  const direction =
    meta.tool_name === "download_browser_files"
      ? "download"
      : meta.tool_name === "upload_browser_files"
        ? "upload"
        : undefined;
  if (
    !direction ||
    meta.file_transfer !== direction ||
    !text(meta.tool_title) ||
    !record(meta.tool_params) ||
    Object.keys(meta.tool_params).length !== 1 ||
    !canonicalOrigin(meta.tool_params.origin) ||
    meta.origin !== meta.tool_params.origin
  )
    throw unsupportedBrowser();
  return {
    kind: direction,
    appId: meta.tool_params.origin as string,
    appName: meta.connector_name as string,
    operation: meta.tool_name as string,
    riskLevel: "high",
    scopes: transferScopes(meta.persist),
  };
}

// A request that needs the Codex automatic reviewer or secure input in the
// ChatGPT app fails first, whatever else it carries, because no answer from a
// person can satisfy it. The service would count a plain accept on a strict
// review path as the reviewer's result.
function refuseUnanswerable(meta: Record<string, any>) {
  if (meta.codex_strict_auto_review !== undefined)
    throw new ApprovalError(
      "This request requires the Codex automatic reviewer, which this integration cannot provide. An answer from the user would not count as that review.",
      "strict_review",
    );
  if (
    meta.codex_requires_user_input !== undefined ||
    meta.codex_guardian_compatible !== undefined ||
    meta.codex_approval_kind === "browser_auth" ||
    meta.codex_approval_kind === "browser_email_otp"
  )
    throw new ApprovalError(
      "This request needs secure input in the ChatGPT app, such as a sign-in form. Claude Code cannot provide it.",
      "user_input",
    );
}

// Sorts a browser request by the field that names its resource, then checks
// it against the reviewed contract of that kind.
function browserApproval(request: ServerRequest): NativeApproval {
  const meta: Record<string, any> = request.params._meta as Record<string, any>;
  if (
    meta.full_cdp_access !== undefined ||
    meta.tool_name === "access_browser_origin_with_raw_cdp"
  )
    throw new ApprovalError(
      "Raw Chrome DevTools Protocol access is outside the supported browser profile.",
      "unsupported",
    );
  if (meta.tool_name === "access_browser_origin")
    return originApproval(request);
  if (meta.sensitive_data !== undefined) return historyApproval(request);
  if (record(meta.tool_params) && meta.tool_params.asset_origins !== undefined)
    throw new ApprovalError(
      "Page-asset downloads are outside the supported browser profile.",
      "unsupported",
    );
  if (meta.tool_name !== undefined || meta.file_transfer !== undefined)
    return transferApproval(request);
  throw new ApprovalError(
    "Unsupported browser approval contract or required capability",
    "unsupported",
  );
}

// This profile accepts only the observed native app-access contract and the
// reviewed browser contracts. Unknown required semantics cannot become an
// ordinary prompt through display text, and no browser request can become an
// app request.
export function nativeApproval(request: ServerRequest): NativeApproval {
  const params = request.params;
  const meta: unknown = params._meta;
  if (record(meta)) refuseUnanswerable(meta);
  if (record(meta) && meta.connector_id === "browser-use")
    return browserApproval(request);
  const schema: unknown = params.requestedSchema;
  if (
    request.method !== "elicitation/create" ||
    params.mode !== "form" ||
    !text(params.message) ||
    !record(meta) ||
    Object.keys(params).some(
      (key) => !["mode", "message", "requestedSchema", "_meta"].includes(key),
    ) ||
    Object.keys(meta).some((key) => !metadataKeys.has(key)) ||
    meta.codex_approval_kind !== "mcp_tool_call" ||
    meta.connector_id !== "computer-use" ||
    !text(meta.connector_name) ||
    !operations.has(meta.tool_name) ||
    !["low", "high"].includes(meta.riskLevel) ||
    !record(meta.tool_params) ||
    Object.keys(meta.tool_params).length !== 1 ||
    !text(meta.tool_params.app) ||
    !Array.isArray(meta.persist) ||
    meta.persist.some(
      (scope: unknown) => !["session", "always"].includes(scope as string),
    ) ||
    new Set(meta.persist).size !== meta.persist.length ||
    (meta.tool_call_id !== undefined && !text(meta.tool_call_id)) ||
    (meta.subtitle !== undefined && !text(meta.subtitle)) ||
    !Array.isArray(meta.tool_params_display) ||
    meta.tool_params_display.length !== 1 ||
    !record(meta.tool_params_display[0]) ||
    meta.tool_params_display[0].name !== "app" ||
    !text(meta.tool_params_display[0].value) ||
    !emptySchema(schema)
  )
    throw new ApprovalError(
      "Unsupported native approval contract or required capability",
    );
  return {
    kind: "app",
    appId: meta.tool_params.app as string,
    // Presentation only. The canonical identifier above is the resource key.
    appName: meta.tool_params_display[0].value as string,
    operation: meta.tool_name as string,
    riskLevel: meta.riskLevel as "low" | "high",
    // A permitted "always" stays unused: only the Codex app keeps a lasting
    // app permission.
    scopes: [
      "once",
      ...(meta.persist.includes("session") ? ["session" as const] : []),
    ],
  };
}

export type ApprovalChoice = ApprovalScope | "decline" | "cancel";
// What the Mod receives for one pending request: the facts that its dialog
// shows and the choices that the request permits. It holds no request data
// that could resolve the request.
export type ApprovalOffer = {
  operationId: string;
  kind: ApprovalKind;
  appId: string;
  appName: string;
  operation: string;
  riskLevel: "low" | "high";
  choices: ApprovalChoice[];
  // Presentation only: the request facts beyond the resource.
  detail?: string;
};
// The scopes that the launcher can honor for one request, which can be fewer
// than the request permits.
export type Availability = {
  scopes: ApprovalScope[];
};

export function approvalOffer(
  pending: PendingRequest,
  available?: Availability,
): ApprovalOffer {
  const { kind, appId, appName, operation, riskLevel, scopes, detail } =
    nativeApproval(pending.request);
  return {
    operationId: pending.operationId,
    kind,
    appId,
    appName,
    operation,
    riskLevel,
    choices: [
      ...scopes.filter((scope) => available?.scopes.includes(scope) ?? true),
      "decline",
      "cancel",
    ],
    ...(detail ? { detail } : {}),
  };
}

// A choice is the user's answer. nativeDecision still checks that the request
// permits the scope.
export function choiceDecision(choice: ApprovalChoice): Decision {
  return choice === "decline" || choice === "cancel"
    ? { action: choice }
    : { action: "accept", content: { scope: choice } };
}

// Converts a host decision to the native result. An accept must name a scope
// that the request permits and, when given, one that the launcher offered.
// The native runtime receives a plain accept for every scope. The launcher
// keeps a session grant for an app, so the runtime asks again at its next
// operation, and the Codex saved-grants store never changes.
//
// The browser service keeps an origin answer for the session of the runtime
// without being asked, and keeps a file-transfer answer only when the reply
// asks for the session. No reply carries a permanent answer, because that
// would write the Codex settings.
export function nativeDecision(
  request: ServerRequest,
  value: unknown,
  offered?: readonly ApprovalScope[],
): Decision {
  const { kind, scopes } = nativeApproval(request);
  if (
    !record(value) ||
    !["accept", "decline", "cancel"].includes(value.action) ||
    Object.keys(value).some(
      (key) => !["action", "content", "_meta"].includes(key),
    ) ||
    (value.content !== undefined &&
      value.content !== null &&
      !record(value.content)) ||
    (value._meta !== undefined && value._meta !== null && !record(value._meta))
  )
    throw new ApprovalError("Malformed host decision");
  // No automatic reviewer or saved-grant provenance exists in this profile.
  const meta = value._meta ?? {};
  if (
    Object.keys(meta).some((key) => key !== "approvals_reviewer") ||
    (meta.approvals_reviewer !== undefined &&
      meta.approvals_reviewer !== "user")
  )
    throw new ApprovalError("Unsupported reviewer or persistence provenance");
  const content = value.content ?? {};
  if (Object.keys(content).some((key) => key !== "scope"))
    throw new ApprovalError("Unsupported decision content");
  const provenance =
    meta.approvals_reviewer === "user"
      ? { _meta: { approvals_reviewer: "user" } }
      : {};
  if (value.action !== "accept") return { action: value.action, ...provenance };
  if (
    !(scopes as unknown[]).includes(content.scope) ||
    (offered !== undefined && !(offered as unknown[]).includes(content.scope))
  )
    throw new ApprovalError("Accept requires an explicitly offered scope");
  const transfer = kind === "download" || kind === "upload";
  return {
    action: "accept",
    content:
      transfer && content.scope === "session" ? { persist: "session" } : {},
    ...provenance,
  };
}
