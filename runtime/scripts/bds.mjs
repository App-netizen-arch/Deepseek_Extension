#!/usr/bin/env node
/**
 * Minimal BDS runtime CLI.
 *
 *   node scripts/bds.mjs skill add <file>   Copy a markdown skill into the
 *                                           skills directory as <name>/SKILL.md
 *   node scripts/bds.mjs skill list         List discovered skills
 *
 * Environment: BDS_WORKSPACE (default cwd), BDS_SKILLS_DIR (default
 * <workspace>/.better-deepseek/skills) — mirrors the runtime skill loader.
 */
import fs from "node:fs";
import path from "node:path";

const workspace = path.resolve(process.env.BDS_WORKSPACE ?? process.cwd());
const skillsDir = path.resolve(process.env.BDS_SKILLS_DIR ?? path.join(workspace, ".better-deepseek", "skills"));

function fail(message, usage = false) {
  console.error(`error: ${message}`);
  if (usage) console.error("usage: bds skill add <file> | bds skill list");
  process.exit(1);
}

function parseFrontmatter(source) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(source);
  const meta = {};
  if (match) {
    for (const line of match[1].split(/\r?\n/)) {
      const idx = line.indexOf(":");
      if (idx > 0) meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }
    return { meta, body: match[2].trim() };
  }
  return { meta, body: source.trim() };
}

function walkSkills(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkSkills(full, out);
    else if (entry.isFile() && entry.name === "SKILL.md") out.push(full);
  }
  return out;
}

async function main() {
  const [group, command, positional] = process.argv.slice(2);
  if (group !== "skill") fail(`unknown command "${group ?? ""}"`, true);

  if (command === "add") {
    if (!positional) fail("skill add requires a source file", true);
    const source = path.resolve(positional);
    if (!fs.existsSync(source) || !fs.statSync(source).isFile()) fail(`not a file: ${source}`);
    const raw = fs.readFileSync(source, "utf8");
    const { meta } = parseFrontmatter(raw);
    const name = (meta.name || path.basename(source).replace(/\.md$/i, ""))
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "");
    if (!name) fail("cannot derive a skill name");
    const targetDir = path.join(skillsDir, name);
    fs.mkdirSync(targetDir, { recursive: true });
    const target = path.join(targetDir, "SKILL.md");
    fs.copyFileSync(source, target);
    console.log(JSON.stringify({ ok: true, added: name, file: target }));
    return;
  }

  if (command === "list") {
    const skills = walkSkills(skillsDir).map((file) => {
      const { meta, body } = parseFrontmatter(fs.readFileSync(file, "utf8"));
      return {
        name: meta.name || path.basename(path.dirname(file)),
        description: meta.description || null,
        version: meta.version || null,
        agents: (meta.agents || "*").trim(),
        body_chars: body.length,
        file,
      };
    });
    console.log(JSON.stringify({ ok: true, count: skills.length, skills }, null, 2));
    return;
  }

  fail(`unknown skill command "${command ?? ""}"`, true);
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
