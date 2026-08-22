/**
 * Tool contracts for the agent tool registry.
 *
 * A tool is a named, schema-described operation with a risk tier that maps
 * directly onto the shared {@link RiskTier} policy (`security-policy.ts`):
 * low/medium auto-allow, high requires an approval, critical is denied.
 */

/** Re-exported risk vocabulary so callers do not import two spellings. */
export type ToolPermissionLevel = "low" | "medium" | "high" | "critical";

/** JSON-schema-ish description of a tool's parameters (subset validator below). */
export type ToolParametersSchema = {
  type: "object";
  properties?: Record<string, { type: "string" | "number" | "boolean" | "array" | "object"; description?: string }>;
  required?: readonly string[];
};

/** Execution context handed to every tool invocation. */
export interface ToolContext {
  /** Agent that requested the invocation. */
  agentId: string;
  /** Task the agent was executing, when known. */
  taskId?: string;
  /** Workspace root the tool may operate in. */
  workspace: string;
  /** Cooperative cancellation signal propagated from the agent. */
  signal?: AbortSignal;
}

/** Executable tool. `execute` must be safe to call with validated params only. */
export interface Tool<TParams = Record<string, unknown>, TResult = unknown> {
  name: string;
  description: string;
  parameters: ToolParametersSchema;
  permissionLevel: ToolPermissionLevel;
  execute(params: TParams, context: ToolContext): Promise<TResult>;
}

/** Wire-friendly view of a tool without its implementation. */
export interface ToolDescriptor {
  name: string;
  description: string;
  parameters: ToolParametersSchema;
  permissionLevel: ToolPermissionLevel;
}

/** Strip the executable from a tool for API responses. */
export function describeTool(tool: Tool): ToolDescriptor {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    permissionLevel: tool.permissionLevel,
  };
}

/**
 * Validate params against the tool's declared schema (minimal subset:
 * object envelope, required keys, primitive property types).
 * @throws with a human-readable message on the first violation.
 */
export function validateParams(schema: ToolParametersSchema, params: unknown): Record<string, unknown> {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    throw new Error("tool params must be an object");
  }
  const record = params as Record<string, unknown>;
  for (const key of schema.required ?? []) {
    if (!(key in record) || record[key] === undefined) throw new Error(`missing required param: ${key}`);
  }
  for (const [key, spec] of Object.entries(schema.properties ?? {})) {
    const value = record[key];
    if (value === undefined) continue;
    const actual = Array.isArray(value) ? "array" : typeof value;
    if (actual !== spec.type) throw new Error(`param ${key} must be ${spec.type}`);
  }
  return record;
}
