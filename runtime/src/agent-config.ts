import fs from "node:fs/promises";
import path from "node:path";
import { WORKSPACE } from "./config.js";

export interface PermissionRule { tool: string; allow?: string[]; deny?: string[]; }
export interface AgentConfig {
  agents_root: string;
  workflows_root: string;
  skills_root: string;
  permissions: PermissionRule[];
  mcp: Array<{ name: string; url?: string; command?: string; args?: string[]; enabled?: boolean; tools?: string[] }>;
}

const ROOT = path.resolve(WORKSPACE);
const CONFIG = path.join(ROOT, ".better-deepseek.jsonc");

function stripJsonc(t: string) {
  return t.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/,\s*([}\]])/g, "$1");
}

export async function loadAgentConfig(): Promise<AgentConfig> {
  let raw = "{}";
  try { raw = await fs.readFile(CONFIG, "utf8"); } catch {}
  const p = JSON.parse(stripJsonc(raw));
  return {
    agents_root: path.join(ROOT, ".better-deepseek", "agents"),
    workflows_root: path.join(ROOT, ".better-deepseek", "workflows"),
    skills_root: path.join(ROOT, ".better-deepseek", "skills"),
    permissions: Array.isArray(p.permissions) ? p.permissions : [],
    mcp: Array.isArray(p.mcp) ? p.mcp : [],
  };
}

function glob(pattern: string, value: string): boolean {
  let source = "^";
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === "*" && pattern[i + 1] === "*") {
      i += 1;
      if (pattern[i + 1] === "/") {
        source += "(?:.*/)?";
        i += 1;
      } else {
        source += ".*";
      }
      continue;
    }
    if (ch === "*") { source += "[^/]*"; continue; }
    if (ch === "?") { source += "[^/]"; continue; }
    if ("\\.^$+()[]{}|".includes(ch)) source += "\\";
    source += ch;
  }
  source += "$";
  return new RegExp(source).test(value);
}

export function permitted(rules: PermissionRule[], tool: string, target = "") {
  const r = rules.find((x) => x.tool === tool);
  if (!r) return true;
  if (r.deny?.some((p) => glob(p, target))) return false;
  return r.allow?.length ? r.allow.some((p) => glob(p, target)) : true;
}
