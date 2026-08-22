/**
 * Skill loader: domain knowledge injected into agent context as prompts.
 *
 * A skill is a `SKILL.md` Markdown file with YAML frontmatter:
 *
 * ```md
 * ---
 * name: Python Best Practices
 * description: Style and idioms for generated Python code.
 * version: 1.2.0
 * agents: demo, worker        # optional; omit or "*" = every agent type
 * ---
 * Body content injected into the agent system prompt.
 * ```
 *
 * Files are discovered recursively under the skills root
 * (`BDS_SKILLS_DIR`, default `<workspace>/.better-deepseek/skills`).
 */
import fs from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { WORKSPACE } from "../config.js";
import type { Dirent } from "node:fs";

/** Parsed, validated skill. */
export interface Skill {
  name: string;
  description?: string;
  version?: string;
  /** Agent types this skill applies to; empty means all types. */
  appliesTo: readonly string[];
  body: string;
  /** Absolute source path. */
  file: string;
}

const MAX_SKILL_BYTES = 64 * 1024;
const SKIP_DIRS = new Set(["node_modules", ".git", ".hg", ".svn"]);

/** Resolve the skills root directory. */
export function skillsDir(explicit?: string): string {
  return path.resolve(explicit ?? process.env.BDS_SKILLS_DIR ?? path.join(path.resolve(WORKSPACE), ".better-deepseek", "skills"));
}

/** Parse frontmatter + body from skill source text. */
export function parseSkill(source: string, file: string): Skill {
  if (Buffer.byteLength(source, "utf8") > MAX_SKILL_BYTES) throw new Error(`skill ${file} exceeds ${MAX_SKILL_BYTES} bytes`);
  let meta: Record<string, unknown> = {};
  let body = source.trim();
  const fenced = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(source);
  if (fenced) {
    try {
      const parsed = parseYaml(fenced[1]) as unknown;
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) meta = parsed as Record<string, unknown>;
    } catch {
      throw new Error(`skill ${file} has invalid frontmatter`);
    }
    body = fenced[2].trim();
  }
  if (!body) throw new Error(`skill ${file} has no body content`);
  const rawName = typeof meta.name === "string" && meta.name.trim() ? meta.name.trim() : path.basename(path.dirname(file));
  const appliesTo = normalizeAgents(meta.agents ?? meta.applies_to);
  const skill: Skill = { name: rawName, appliesTo, body, file };
  if (typeof meta.description === "string" && meta.description.trim()) skill.description = meta.description.trim();
  if (typeof meta.version === "string" || typeof meta.version === "number") skill.version = String(meta.version);
  return skill;
}

function normalizeAgents(value: unknown): string[] {
  if (value === undefined || value === null || value === "*" || value === true) return [];
  const list = Array.isArray(value)
    ? value.map(String)
    : typeof value === "string"
      ? value.split(",")
      : [];
  return list.map((entry) => entry.trim().toLowerCase()).filter((entry) => entry.length > 0);
}

/** True when the skill should be injected for an agent of `agentType`. */
export function skillAppliesTo(skill: Pick<Skill, "appliesTo">, agentType: string): boolean {
  const type = agentType.toLowerCase();
  return skill.appliesTo.length === 0 || skill.appliesTo.includes("*") || skill.appliesTo.includes(type);
}

/** Recursively discover SKILL.md files; malformed ones are skipped silently. */
export async function loadSkills(dir?: string): Promise<Skill[]> {
  const root = skillsDir(dir);
  const out: Skill[] = [];
  async function walk(current: string): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) await walk(full);
      } else if (entry.isFile() && entry.name === "SKILL.md") {
        try {
          out.push(parseSkill(await fs.readFile(full, "utf8"), full));
        } catch {
          // invalid skills never break discovery
        }
      }
    }
  }
  await walk(root);
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Skills relevant to one agent type. */
export async function getSkillsForAgent(agentType: string, dir?: string): Promise<Skill[]> {
  return (await loadSkills(dir)).filter((skill) => skillAppliesTo(skill, agentType));
}

/**
 * Compose an agent system prompt: base instructions followed by skill
 * sections. Deterministic ordering keeps prompts stable across runs.
 */
export function buildSystemPrompt(base: string, skills: readonly Skill[]): string {
  const sections: string[] = [];
  if (base.trim()) sections.push(base.trim());
  for (const skill of skills) {
    const header = [skill.name, skill.version ? `v${skill.version}` : null].filter(Boolean).join(" ");
    sections.push(`<skill name="${header}">\n${skill.body.trim()}\n</skill>`);
  }
  return sections.join("\n\n");
}
