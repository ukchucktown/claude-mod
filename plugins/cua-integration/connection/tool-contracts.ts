import { isAbsolute } from "node:path";
import { validateObservationResult } from "../observations/result.ts";
import { ConnectionError, object } from "./protocol.ts";

// Constraint-only schemas from the recorded discovery probe. Descriptions and
// presentation metadata may change, but unreviewed constraints may not.
export const INPUT_SCHEMAS = {
  js: {
    type: "object",
    additionalProperties: false,
    properties: {
      code: { type: "string" },
      timeout_ms: { type: "integer", minimum: 1 },
      title: { type: "string", minLength: 1, maxLength: 80 },
    },
    required: ["code"],
  },
  js_reset: { type: "object", additionalProperties: false, properties: {} },
  js_add_node_module_dir: {
    type: "object",
    additionalProperties: false,
    properties: { path: { type: "string", minLength: 1 } },
    required: ["path"],
  },
  turn_ended: {
    type: "object",
    additionalProperties: false,
    properties: {
      hook_event_name: { type: "string", minLength: 1 },
      session_id: { type: "string", minLength: 1 },
      turn_id: { type: "string", minLength: 1 },
    },
    required: ["hook_event_name", "session_id", "turn_id"],
  },
} as const;
export type ToolName = keyof typeof INPUT_SCHEMAS;
export type Tool = {
  name: ToolName;
  inputSchema: Record<string, unknown>;
  [key: string]: unknown;
};
function normalized(value: unknown, propertyMap = false): string {
  if (Array.isArray(value))
    return JSON.stringify(value.map((item) => normalized(item)).sort());
  if (object(value))
    return JSON.stringify(
      Object.entries(value)
        .filter(
          ([key]) =>
            propertyMap || !["description", "title", "$schema"].includes(key),
        )
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [
          key,
          normalized(item, !propertyMap && key === "properties"),
        ]),
    );
  return JSON.stringify(value);
}
export function validateTools(value: unknown): Tool[] {
  if (
    !object(value) ||
    !Array.isArray(value.tools) ||
    value.nextCursor !== undefined
  )
    throw new ConnectionError(
      "protocol",
      "Expected a complete, unpaginated tool catalog",
    );
  const tools = new Map<string, Tool>();
  for (const tool of value.tools) {
    if (!object(tool) || typeof tool.name !== "string" || tools.has(tool.name))
      throw new ConnectionError("protocol", "Malformed or duplicate tool");
    if (!Object.hasOwn(INPUT_SCHEMAS, tool.name))
      throw new ConnectionError("protocol", `Unreviewed tool: ${tool.name}`);
    const name = tool.name as ToolName;
    if (normalized(tool.inputSchema) !== normalized(INPUT_SCHEMAS[name]))
      throw new ConnectionError(
        "protocol",
        `Incompatible tool schema: ${name}`,
      );
    tools.set(name, tool as Tool);
  }
  for (const name of Object.keys(INPUT_SCHEMAS))
    if (!tools.has(name))
      throw new ConnectionError("protocol", `Missing tool: ${name}`);
  return [...tools.values()];
}
export function validateArguments(
  name: string,
  args: unknown,
): asserts args is Record<string, unknown> {
  if (!Object.hasOwn(INPUT_SCHEMAS, name))
    throw new ConnectionError("state", `Unknown tool: ${name}`);
  if (!object(args))
    throw new ConnectionError("state", "Tool arguments must be an object");
  const schema = INPUT_SCHEMAS[name as ToolName];
  for (const key of Object.keys(args))
    if (!Object.hasOwn(schema.properties, key))
      throw new ConnectionError("state", `Unexpected argument: ${key}`);
  const required: readonly string[] =
    "required" in schema ? schema.required : [];
  for (const key of required)
    if (!Object.hasOwn(args, key))
      throw new ConnectionError("state", `Missing argument: ${key}`);
  for (const [key, value] of Object.entries(args)) {
    const constraint = (
      schema.properties as Record<string, Record<string, unknown>>
    )[key]!;
    if (
      constraint.type === "string" &&
      (typeof value !== "string" ||
        Array.from(value).length < ((constraint.minLength as number) ?? 0) ||
        Array.from(value).length >
          ((constraint.maxLength as number) ?? Infinity))
    )
      throw new ConnectionError("state", `Invalid string argument: ${key}`);
    if (
      constraint.type === "integer" &&
      (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    )
      throw new ConnectionError("state", `Invalid integer argument: ${key}`);
  }
  if (name === "js_add_node_module_dir" && !isAbsolute(args.path as string))
    throw new ConnectionError("state", "Module directory must be absolute");
}
export const validateResult = validateObservationResult;
