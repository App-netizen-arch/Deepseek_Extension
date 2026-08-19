import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const MAX_SOURCE = 256 * 1024;
const COMPILE_TIMEOUT = 60_000;

function run(command: string, args: string[], cwd: string): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill("SIGKILL"); } catch { /* exited */ }
      resolve({ code: null, stdout, stderr, timedOut: true });
    }, COMPILE_TIMEOUT);
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8").slice(0, 512_000); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8").slice(0, 512_000); });
    child.once("error", (error) => { if (!settled) { settled = true; clearTimeout(timer); reject(error); } });
    child.once("close", (code) => { if (!settled) { settled = true; clearTimeout(timer); resolve({ code, stdout, stderr, timedOut: false }); } });
  });
}

function documentSource(source: string): string {
  if (source.includes("\\documentclass")) return source;
  return `\\documentclass[preview,border=2pt]{standalone}\n\\usepackage{amsmath,amssymb}\n\\usepackage{tikz}\n\\begin{document}\n${source}\n\\end{document}\n`;
}

export interface TikzRenderResult {
  id: string;
  svg: string;
  source: string;
  validated: true;
  compiler: "pdflatex+dvisvgm";
}

export async function renderTikz(source: string): Promise<TikzRenderResult> {
  if (typeof source !== "string" || !source.trim()) throw new Error("TikZ source is required");
  if (Buffer.byteLength(source, "utf8") > MAX_SOURCE) throw new Error("TikZ source exceeds 256 KiB");
  if (/\\(?:input|include|openin|write18|ShellEscape)\b/i.test(source)) throw new Error("TikZ source contains a forbidden file/process primitive");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bds-tikz-"));
  const tex = path.join(dir, "diagram.tex");
  const pdf = path.join(dir, "diagram.pdf");
  const svg = path.join(dir, "diagram.svg");
  try {
    await fs.writeFile(tex, documentSource(source), { encoding: "utf8", mode: 0o600 });
    const compiled = await run("pdflatex", ["-interaction=nonstopmode", "-halt-on-error", "-no-shell-escape", "diagram.tex"], dir);
    if (compiled.timedOut) throw new Error("TikZ compilation timed out");
    if (compiled.code !== 0) throw new Error(`TikZ compilation failed: ${compiled.stderr.trim() || compiled.stdout.trim()}`);
    await fs.access(pdf);
    const vector = await run("dvisvgm", ["--pdf", "--no-fonts", "--output=diagram.svg", "diagram.pdf"], dir);
    if (vector.timedOut) throw new Error("SVG conversion timed out");
    if (vector.code !== 0) throw new Error(`SVG conversion failed: ${vector.stderr.trim() || vector.stdout.trim()}`);
    const output = await fs.readFile(svg, "utf8");
    if (!output.includes("<svg")) throw new Error("compiler returned invalid SVG");
    return { id: `tikz_${randomUUID().replaceAll("-", "").slice(0, 16)}`, svg: output, source, validated: true, compiler: "pdflatex+dvisvgm" };
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
