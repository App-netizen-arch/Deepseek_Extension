import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import katex from "katex";
import type { RuntimeStore } from "./store.js";

export type MathInputKind = "latex" | "mathml" | "image";
export type MathEngine = "direct" | "pix2tex" | "pix2text";

export interface MathAnalyzeRequest {
  type?: "equation";
  content: string;
  kind: MathInputKind;
  source_url?: string;
  page_title?: string;
  engine?: "auto" | "pix2tex" | "pix2text";
}

export interface MathAnalyzeResult {
  latex: string;
  confidence: number | null;
  alternatives: string[];
  engine: MathEngine;
  rendered_html: string;
  source: {
    kind: MathInputKind;
    source_url?: string;
    page_title?: string;
  };
}

const MAX_CONTENT_BYTES = 8 * 1024 * 1024;
const OCR_TIMEOUT_MS = 60_000;
const OCR_SCRIPT = path.resolve(process.cwd(), "scripts/pix2text-ocr.py");

function normalizeLatex(value: string): string {
  return value
    .trim()
    .replace(/^\$\$?\s*/, "")
    .replace(/\s*\$\$?$/, "")
    .replace(/^\\\[\s*/, "")
    .replace(/\s*\\\]$/, "")
    .trim();
}

function mathmlToLatex(value: string): string {
  const input = value.trim();
  const annotation = input.match(/<annotation[^>]*encoding=["']application\\/x-tex["'][^>]*>([\\s\\S]*?)<\\/annotation>/i);
  if (annotation) return normalizeLatex(annotation[1]);
  const semantics = input.match(/<semantics[^>]*>[\\s\\S]*?<annotation[^>]*>([\\s\\S]*?)<\\/annotation>[\\s\\S]*?<\\/semantics>/i);
  if (semantics) return normalizeLatex(semantics[1]);
  throw new Error("MathML has no embedded application/x-tex annotation");
}

function renderLatex(latex: string): string {
  return katex.renderToString(latex, {
    displayMode: true,
    throwOnError: true,
    trust: false,
    strict: "warn",
    output: "htmlAndMathml",
  });
}

function decodeJsonLines(output: string): { latex: string; confidence: number | null } {
  const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const value = JSON.parse(lines[i]) as { latex?: unknown; text?: unknown; confidence?: unknown; score?: unknown };
      const latex = typeof value.latex === "string" ? value.latex : typeof value.text === "string" ? value.text : "";
      if (!latex.trim()) continue;
      const rawConfidence = value.confidence ?? value.score;
      const confidence = typeof rawConfidence === "number" && Number.isFinite(rawConfidence)
        ? Math.max(0, Math.min(1, rawConfidence))
        : null;
      return { latex: normalizeLatex(latex), confidence };
    } catch {
      // Keep scanning for a final JSON result.
    }
  }
  throw new Error("OCR adapter returned no JSON result");
}

function runProcess(command: string, args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string; code: number | null; timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill("SIGKILL"); } catch { /* exited */ }
      resolve({ stdout, stderr, code: null, timedOut: true });
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8").slice(0, 2 * 1024 * 1024); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8").slice(0, 64 * 1024); });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, code, timedOut: false });
    });
  });
}

async function runPix2Tex(imagePath: string): Promise<{ latex: string; confidence: number | null }> {
  const result = await runProcess("python3", ["-m", "pix2tex", imagePath], OCR_TIMEOUT_MS);
  if (result.timedOut) throw new Error("pix2tex timed out");
  if (result.code !== 0) throw new Error(`pix2tex exited with ${result.code}: ${result.stderr.trim()}`);
  const lines = result.stdout.trim().split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const candidates = lines.reverse();
  const raw = candidates.find((line) => line.includes("\\"));
  if (!raw) throw new Error("pix2tex returned no LaTeX");
  const latex = raw.includes(": ") ? raw.slice(raw.indexOf(": ") + 2) : raw;
  return { latex: normalizeLatex(latex), confidence: null };
}

async function runPix2Text(imagePath: string): Promise<{ latex: string; confidence: number | null }> {
  const result = await runProcess("python3", [OCR_SCRIPT, imagePath], OCR_TIMEOUT_MS);
  if (result.timedOut) throw new Error("Pix2Text timed out");
  if (result.code !== 0) throw new Error(`Pix2Text exited with ${result.code}: ${result.stderr.trim()}`);
  return decodeJsonLines(result.stdout);
}

async function imageBytes(content: string): Promise<Buffer> {
  const match = content.match(/^data:[^;]+;base64,(.+)$/s);
  if (!match) throw new Error("image input must be a local data: URL");
  const buffer = Buffer.from(match[1], "base64");
  if (!buffer.length) throw new Error("empty image payload");
  if (buffer.byteLength > MAX_CONTENT_BYTES) throw new Error("image exceeds 8 MiB limit");
  return buffer;
}

export async function analyzeMath(request: MathAnalyzeRequest, store: RuntimeStore): Promise<MathAnalyzeResult> {
  if (!request || typeof request.content !== "string" || !request.content.trim()) throw new Error("math content is required");
  if (!["latex", "mathml", "image"].includes(request.kind)) throw new Error("unsupported math input kind");
  if (Buffer.byteLength(request.content, "utf8") > MAX_CONTENT_BYTES) throw new Error("math input exceeds 8 MiB limit");

  const id = randomUUID();
  let latex: string;
  let confidence: number | null;
  let engine: MathEngine;
  const tempDir = request.kind === "image" ? await fs.mkdtemp(path.join(os.tmpdir(), "bds-math-")) : null;

  try {
    if (request.kind === "latex") {
      latex = normalizeLatex(request.content);
      confidence = 1;
      engine = "direct";
    } else if (request.kind === "mathml") {
      latex = mathmlToLatex(request.content);
      confidence = 1;
      engine = "direct";
    } else {
      const bytes = await imageBytes(request.content);
      const imagePath = path.join(tempDir!, "equation.png");
      await fs.writeFile(imagePath, bytes, { mode: 0o600 });
      const selected = request.engine && request.engine !== "auto" ? [request.engine] : ["pix2tex", "pix2text"] as const;
      let result: { latex: string; confidence: number | null } | null = null;
      let selectedEngine: MathEngine | null = null;
      const errors: string[] = [];
      for (const candidate of selected) {
        try {
          result = candidate === "pix2tex" ? await runPix2Tex(imagePath) : await runPix2Text(imagePath);
          selectedEngine = candidate;
          break;
        } catch (error) {
          errors.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (!result || !selectedEngine) throw new Error(`no local OCR engine succeeded (${errors.join("; ")})`);
      latex = normalizeLatex(result.latex);
      confidence = result.confidence;
      engine = selectedEngine;
    }

    if (!latex) throw new Error("no LaTeX detected");
    const rendered_html = renderLatex(latex);
    const result: MathAnalyzeResult = {
      latex,
      confidence,
      alternatives: [],
      engine,
      rendered_html,
      source: { kind: request.kind, ...(request.source_url ? { source_url: request.source_url } : {}), ...(request.page_title ? { page_title: request.page_title } : {}) },
    };
    store.audit("math.analyze.finish", { id, engine, kind: request.kind, confidence, latex_length: latex.length });
    return result;
  } finally {
    if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
  }
}

export { mathmlToLatex, normalizeLatex, renderLatex, runPix2Text, runPix2Tex };
