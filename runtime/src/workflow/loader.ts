/**
 * Workflow definition loader.
 *
 * Reads `*.yml`, `*.yaml`, and `*.json` files from a configured directory
 * (default `<workspace>/.better-deepseek/workflows`, override with
 * `BDS_WORKFLOWS_DIR`) and validates them into {@link WorkflowDefinition}s.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { WORKSPACE } from "../config.js";

/** One executable step inside a workflow. */
export interface WorkflowStepDefinition {
  /** Unique step id within the workflow. */
  id: string;
  /** `tool` invokes a registry tool; `agent` spawns and runs an agent. */
  type: "tool" | "agent";
  /** Tool name (type=tool) or agent type (type=agent). */
  target: string;
  /** Params object; string leaves may contain {{template}} expressions. */
  params?: Record<string, unknown>;
  /** Step ids that must complete before this one starts. */
  depends_on?: readonly string[];
  /** Skip the step (status=skipped) when this template resolves falsy. */
  when?: string;
  /** Retry budget for transient failures (default 0). */
  retries?: number;
  /** A failed step marks the run failed unless this is true. */
  continue_on_error?: boolean;
  /** Hard per-step timeout in ms. */
  timeout_ms?: number;
}

/** A parsed, validated workflow definition. */
export interface WorkflowDefinition {
  name: string;
  description?: string;
  steps: WorkflowStepDefinition[];
  /** Absolute path of the source file. */
  file: string;
}

const DEFAULT_DIR = () => path.join(path.resolve(WORKSPACE), ".better-deepseek", "workflows");

/** Resolve the directory workflow files are loaded from. */
export function workflowsDir(explicit?: string): string {
  if (explicit) return path.resolve(explicit);
  const env = process.env.BDS_WORKFLOWS_DIR;
  return path.resolve(env ?? DEFAULT_DIR());
}

function rawToSteps(rawSteps: unknown): WorkflowStepDefinition[] {
  if (!Array.isArray(rawSteps)) throw new Error("workflow steps must be an array");
  return rawSteps.map((raw, index) => {
    const step = raw as Record<string, unknown>;
    // Accept the spec-style shorthand `tool: web_search` / `agent: summarizer`
    // alongside the canonical `target` field.
    const shorthand = step.tool !== undefined ? "tool" : step.agent !== undefined ? "agent" : undefined;
    const type = typeof step.type === "string" ? step.type : shorthand;
    if (type !== "tool" && type !== "agent") throw new Error(`step ${index}: type must be "tool" or "agent"`);
    const target = String((step as Record<string, unknown>).target ?? (shorthand ? step[shorthand] : undefined));
    if (!target) throw new Error(`step ${index}: ${type} target is required`);
    if (step.params !== undefined && (typeof step.params !== "object" || step.params === null || Array.isArray(step.params))) {
      throw new Error(`step ${index}: params must be an object`);
    }
    const depends = step.depends_on ?? step.dependsOn;
    if (depends !== undefined && !Array.isArray(depends)) throw new Error(`step ${index}: depends_on must be an array`);
    return {
      id: String(step.id ?? `step_${index + 1}`),
      type,
      target,
      ...(step.params !== undefined ? { params: step.params as Record<string, unknown> } : {}),
      ...(Array.isArray(depends) ? { depends_on: depends.map(String) } : {}),
      ...(typeof step.when === "string" ? { when: step.when } : {}),
      ...(typeof step.retries === "number" ? { retries: Math.max(0, Math.min(10, Math.floor(step.retries))) } : {}),
      ...(typeof step.continue_on_error === "boolean" || typeof step.continueOnError === "boolean"
        ? { continue_on_error: Boolean(step.continue_on_error ?? step.continueOnError) }
        : {}),
      ...(typeof step.timeout_ms === "number" || typeof step.timeoutMs === "number"
        ? { timeout_ms: Math.max(1, Number(step.timeout_ms ?? step.timeoutMs)) }
        : {}),
    };
  });
}

/** Parse a definition string (YAML or JSON) into a validated shape (no file IO). */
export function parseWorkflow(source: string, file: string): WorkflowDefinition {
  let doc: unknown;
  try {
    doc = file.endsWith(".json") ? JSON.parse(source) : parseYaml(source);
  } catch (error) {
    throw new Error(`workflow ${file} is not valid YAML/JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw new Error(`workflow ${file} must be an object`);
  const record = doc as Record<string, unknown>;
  const name = typeof record.name === "string" && record.name.trim() ? record.name.trim() : path.basename(file).replace(/\.(ya?ml|json)$/i, "");
  const definition: WorkflowDefinition = {
    name,
    steps: rawToSteps(record.steps),
    file,
  };
  if (typeof record.description === "string") definition.description = record.description;
  validateGraph(definition);
  return definition;
}

/** Reject duplicate ids, self/unknown dependencies, and dependency cycles. */
export function validateGraph(definition: WorkflowDefinition): void {
  const seen = new Set<string>();
  for (const step of definition.steps) {
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(step.id)) throw new Error(`invalid step id: ${step.id}`);
    if (seen.has(step.id)) throw new Error(`duplicate step id: ${step.id}`);
    seen.add(step.id);
  }
  for (const step of definition.steps) {
    for (const dep of step.depends_on ?? []) {
      if (dep === step.id) throw new Error(`step ${step.id} depends on itself`);
      if (!seen.has(dep)) throw new Error(`step ${step.id} depends on unknown step ${dep}`);
    }
  }
  // Cycle check via iterative DFS.
  const state = new Map<string, 0 | 1 | 2>();
  const byId = new Map(definition.steps.map((s) => [s.id, s]));
  const visit = (id: string): void => {
    const status = state.get(id) ?? 0;
    if (status === 1) throw new Error(`dependency cycle involving step ${id}`);
    if (status === 2) return;
    state.set(id, 1);
    for (const dep of byId.get(id)?.depends_on ?? []) visit(dep);
    state.set(id, 2);
  };
  for (const step of definition.steps) visit(step.id);
}

/** Load every valid workflow definition in the directory; unreadable entries are skipped. */
export async function loadWorkflowDefinitions(dir?: string): Promise<WorkflowDefinition[]> {
  const root = workflowsDir(dir);
  await fs.mkdir(root, { recursive: true });
  const entries = (await fs.readdir(root)).filter((name) => /\.(ya?ml|json)$/i.test(name)).sort();
  const out: WorkflowDefinition[] = [];
  for (const entry of entries) {
    try {
      out.push(parseWorkflow(await fs.readFile(path.join(root, entry), "utf8"), path.join(root, entry)));
    } catch {
      // Invalid definitions are skipped so one bad file cannot break discovery.
    }
  }
  return out;
}

/** Fetch one definition by name, or undefined when absent. */
export async function findWorkflow(name: string, dir?: string): Promise<WorkflowDefinition | undefined> {
  return (await loadWorkflowDefinitions(dir)).find((definition) => definition.name === name);
}
