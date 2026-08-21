/**
 * Tool registry: in-memory map of known tools with enable/disable state.
 *
 * When constructed with a SQLite connection the enabled/disabled flag is
 * persisted in `runtime_meta` (`tool:<name>` keys) and survives restarts;
 * tools default to enabled unless explicitly disabled.
 */
import type Database from "better-sqlite3";
import { describeTool, type Tool, type ToolDescriptor } from "./tool.js";

/** Persistence hooks; satisfied by a better-sqlite3 connection. */
export interface ToolStateStore {
  getMeta(key: string): string | undefined;
  setMeta(key: string, value: string): void;
}

const toolKey = (name: string) => `tool:${name}`;

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();
  private readonly disabled = new Set<string>();

  constructor(private readonly state?: ToolStateStore) {}

  /** Register (or replace) a tool. Names are validated for safe routing. */
  register(tool: Tool): void {
    if (!/^[a-z][a-z0-9_.:/-]{0,127}$/.test(tool.name)) throw new Error(`invalid tool name: ${tool.name}`);
    if (!tool.description) throw new Error("tool description is required");
    if (!["low", "medium", "high", "critical"].includes(tool.permissionLevel)) {
      throw new Error(`invalid permission level for ${tool.name}`);
    }
    this.tools.set(tool.name, tool);
    const persisted = this.state?.getMeta(toolKey(tool.name));
    if (persisted === "disabled") this.disabled.add(tool.name);
    else if (persisted === "enabled") this.disabled.delete(tool.name);
  }

  /** Fetch an executable tool by name, or undefined when unknown. */
  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  /** Descriptor list (no executables), sorted by name. */
  list(): Array<ToolDescriptor & { enabled: boolean }> {
    return [...this.tools.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((tool) => ({ ...describeTool(tool), enabled: !this.disabled.has(tool.name) }));
  }

  /** True when the tool exists and is not disabled. */
  isEnabled(name: string): boolean {
    return this.tools.has(name) && !this.disabled.has(name);
  }

  /** Enable a registered tool; persists when a state store is attached. */
  enable(name: string): void {
    this.requireKnown(name);
    this.disabled.delete(name);
    this.state?.setMeta(toolKey(name), "enabled");
  }

  /** Disable a registered tool; persists when a state store is attached. */
  disable(name: string): void {
    this.requireKnown(name);
    this.disabled.add(name);
    this.state?.setMeta(toolKey(name), "disabled");
  }

  private requireKnown(name: string): void {
    if (!this.tools.has(name)) throw new Error(`unknown tool: ${name}`);
  }
}
