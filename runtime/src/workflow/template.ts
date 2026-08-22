/**
 * Workflow template interpolation.
 *
 * Templates reference run inputs and upstream step outputs with mustache-style
 * paths resolved against `{ input, ...stepsById }`, where each step entry is
 * `{ status, result }`. A string that is exactly one template preserves the
 * resolved value's type; embedded templates are coerced to strings.
 */

/** Context available to template resolution during a workflow run. */
export interface TemplateContext {
  input: Record<string, unknown>;
  /** Completed step snapshots by id: `{ status, result }`. */
  steps: Record<string, { status: string; result?: unknown }>;
}

const TEMPLATE = /\{\{\s*([^}]+?)\s*\}\}/g;

/**
 * Resolve a dot path like `input.topic` or `search.result.url` or
 * `rows.items.0.id` against a root object. Returns undefined when any
 * segment is missing.
 */
export function resolvePath(root: unknown, path: string): unknown {
  const segments = path.trim().split(".").filter(Boolean);
  if (segments.length === 0) return undefined;
  let current: unknown = root;
  for (const segment of segments) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function renderString(template: string, context: TemplateContext): unknown {
  const whole = /^\{\{\s*([^}]+?)\s*\}\}$/.exec(template);
  const root = () => ({ input: context.input, steps: context.steps, ...context.steps });
  if (whole) {
    // Whole-string template: preserve the value's runtime type.
    return resolvePath(root(), whole[1]);
  }
  return template.replace(TEMPLATE, (_match, path: string) => {
    const value = resolvePath(root(), path);
    if (value === null || value === undefined) return "";
    return typeof value === "object" ? JSON.stringify(value) : String(value);
  });
}

/**
 * Deep-resolve templates inside params: strings are interpolated; objects and
 * arrays are traversed recursively; primitives pass through unchanged.
 */
export function resolveTemplates<T>(value: T, context: TemplateContext): T {
  if (typeof value === "string") return renderString(value, context) as T;
  if (Array.isArray(value)) {
    return value.map((entry) => resolveTemplates(entry, context)) as T;
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = resolveTemplates(entry, context);
    }
    return out as T;
  }
  return value;
}
