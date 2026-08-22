/**
 * Subagent permission inheritance.
 *
 * Children may only ever receive permissions that are equal to or more
 * restrictive than their parent's. Overrides never expand capability:
 * tool lists intersect, and numeric limits take the minimum against the
 * effective parent value.
 */
import type { AgentRegistry } from "./registry.js";
import type { AgentPermissions } from "./agent.js";

/** Ceiling applied when an agent does not define `maxSubagents` itself. */
export const DEFAULT_MAX_SUBAGENTS = 4;

/** Maximum parent-chain depth a new subagent may occupy (root = 0). */
export const MAX_SUBAGENT_DEPTH = 3;

function cloneTools(tools: readonly string[]): string[] {
  return [...new Set(tools)];
}

/**
 * Merge a parent's permissions with a child override, clamping the result to
 * the parent's capability envelope.
 *
 * - `tools`: intersection when both sides define it; otherwise whichever is defined.
 * - `maxSubagents`: minimum of the override and the effective parent limit.
 * - Fields undefined on both sides stay absent (defaults apply at enforcement time).
 */
export function restrictPermissions(parent: AgentPermissions, override?: AgentPermissions): AgentPermissions {
  const result: AgentPermissions = {};
  if (override !== undefined && (typeof override !== "object" || override === null || Array.isArray(override))) {
    throw new Error("permissionsOverride must be an object");
  }
  if (parent.tools !== undefined && override?.tools !== undefined) {
    const allowed = new Set(parent.tools);
    result.tools = cloneTools(override.tools.filter((tool) => allowed.has(tool)));
  } else if (parent.tools !== undefined) {
    result.tools = cloneTools(parent.tools);
  } else if (override?.tools !== undefined) {
    result.tools = cloneTools(override.tools);
  }
  const parentLimit = parent.maxSubagents ?? DEFAULT_MAX_SUBAGENTS;
  result.maxSubagents =
    override?.maxSubagents !== undefined ? Math.min(parentLimit, override.maxSubagents) : parentLimit;
  return result;
}

/** Number of ancestors above the agent (root agents are at depth 0). */
export function agentDepth(registry: Pick<AgentRegistry, "get">, agentId: string): number {
  let depth = 0;
  let current = registry.get(agentId);
  const seen = new Set<string>([agentId]);
  while (current?.parentId) {
    if (seen.has(current.parentId)) throw new Error("subagent parent chain contains a cycle");
    seen.add(current.parentId);
    current = registry.get(current.parentId);
    depth += 1;
    if (depth > MAX_SUBAGENT_DEPTH + 1) break; // bounded walk; cycle-free by construction
  }
  return depth;
}
