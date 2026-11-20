import type { Decision, PendingRequest, ServerRequest } from "../contracts.ts";
import { changesLayout } from "../mod/hooks/display.ts";

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

// Why the boundary refuses a request. The reasons name the cause, not a
// severity: a defect in the request, a question that only the Codex automatic
// reviewer may answer, or a question that needs secure input in the ChatGPT
// app.
export type ApprovalRefusal = "malformed" | "strict_review" | "user_input";

export class ApprovalError extends Error {
  readonly reason: ApprovalRefusal;
  constructor(message: string, reason: ApprovalRefusal = "malformed") {
    super(message);
    this.reason = reason;
  }
}

// The scopes of an accept: this request, or the session of the launcher. No
// scope outlives the launcher. A lasting permission belongs
// in the Codex app (decision 0002), so the launcher never offers "always".
export type ApprovalScope = "once" | "session";
// The one resource of an approval is a native app. The boundary refuses a
// request for each other resource.
export type NativeApproval = {
  // The canonical resource: a bundle identifier.
  appId: string;
  // Presentation only: the app name.
  appName: string;
  operation: string;
  riskLevel: "low" | "high";
  // The scopes that the request permits and the launcher may offer.
  scopes: ApprovalScope[];
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
    meta.codex_guardian_compatible !== undefined
  )
    throw new ApprovalError(
      "This request needs secure input in the ChatGPT app, such as a sign-in form. Claude Code cannot provide it.",
      "user_input",
    );
}

// The boundary accepts only the observed native app-access contract. Unknown
// required semantics cannot become an ordinary prompt through display text,
// and a request of another connector cannot become an app request.
export function nativeApproval(request: ServerRequest): NativeApproval {
  const params = request.params;
  const meta: unknown = params._meta;
  if (record(meta)) refuseUnanswerable(meta);
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
    // The identifier is the key of a session grant, so the boundary refuses
    // an identifier with a character that changes direction or layout, and
    // never rewrites it. The display name can hold such a character: the Mod
    // shows a visible form of it.
    changesLayout(meta.tool_params.app) ||
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
  // The form of the offer on the control files. The Mod and the launcher can
  // have different versions after a Mod reload, and an earlier launcher also
  // sent offers of the browser service with another value here. A Mod shows
  // only an offer with the value "app" and cancels each other offer.
  kind: "app";
  appId: string;
  appName: string;
  operation: string;
  riskLevel: "low" | "high";
  choices: ApprovalChoice[];
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
  const { appId, appName, operation, riskLevel, scopes } = nativeApproval(
    pending.request,
  );
  return {
    operationId: pending.operationId,
    kind: "app",
    appId,
    appName,
    operation,
    riskLevel,
    choices: [
      ...scopes.filter((scope) => available?.scopes.includes(scope) ?? true),
      "decline",
      "cancel",
    ],
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
export function nativeDecision(
  request: ServerRequest,
  value: unknown,
  offered?: readonly ApprovalScope[],
): Decision {
  const { scopes } = nativeApproval(request);
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
  return { action: "accept", content: {}, ...provenance };
}
