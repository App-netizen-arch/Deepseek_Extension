import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { RuntimeStore } from "./store.js";
import type { MathIRDocument } from "./mathir.js";

const PIPELINE = path.resolve(process.cwd(), "scripts/math-pdf-pipeline.py");
const MAX_PDF_BYTES = 100 * 1024 * 1024;
const PIPELINE_TIMEOUT_MS = 10 * 60_000;

function allowedDocumentPath(input: string): string {
  const resolved = path.resolve(input.replace(/^~(?=\/|\\)/, process.env.HOME ?? "~"));
  const root = path.resolve(process.env.BDS_DOCUMENT_ROOT ?? process.env.BDS_WORKSPACE ?? process.cwd());
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("PDF is outside the configured document root");
  const lower = resolved.toLowerCase();
  if (lower.includes(`${path.sep}.ssh${path.sep}`) || lower.endsWith(`${path.sep}.env`) || lower.includes(`${path.sep}.env.`)) {
    throw new Error("sensitive files are not accepted by MathBridge");
  }
  return resolved;
}

function runPipeline(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("python3", [PIPELINE, filePath], { shell: false, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    let finished = false;
    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      try { child.kill("SIGKILL"); } catch { /* already exited */ }
      reject(new Error("Math PDF pipeline timed out"));
    }, PIPELINE_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); if (stdout.length > 12_000_000) stdout = stdout.slice(0, 12_000_000); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); if (stderr.length > 512_000) stderr = stderr.slice(0, 512_000); });
    child.once("error", (error) => { if (!finished) { finished = true; clearTimeout(timer); reject(error); } });
    child.once("close", (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (code !== 0) reject(new Error(stderr.trim() || `Math PDF pipeline exited with ${code}`));
      else resolve(stdout.trim());
    });
  });
}

export interface MathDocumentIngestResult {
  document: MathIRDocument;
  ingestion: { path: string; bytes: number; duration_ms: number };
}

export async function ingestMathPdf(file: string, store: RuntimeStore): Promise<MathDocumentIngestResult> {
  const pdfPath = allowedDocumentPath(file);
  const stat = await fs.stat(pdfPath);
  if (!stat.isFile() || path.extname(pdfPath).toLowerCase() !== ".pdf") throw new Error("file must be a PDF");
  if (stat.size > MAX_PDF_BYTES) throw new Error("PDF exceeds the 100 MiB MathBridge limit");
  const started = Date.now();
  const raw = JSON.parse(await runPipeline(pdfPath)) as { ok?: boolean; error?: string; title?: string; pages?: number; sections?: unknown[]; equations?: unknown[]; theorems?: unknown[]; figures?: unknown[]; tables?: unknown[]; references?: unknown[]; relations?: unknown[]; metadata?: Record<string, unknown> };
  if (!raw.ok) throw new Error(raw.error || "Math PDF ingestion failed");
  const document: MathIRDocument = {
    id: `doc_${randomUUID().replaceAll("-", "").slice(0, 16)}`,
    title: String(raw.title || path.basename(pdfPath, ".pdf")),
    source_path: pdfPath,
    created_at: new Date().toISOString(),
    pages: Number(raw.pages || 0),
    sections: Array.isArray(raw.sections) ? raw.sections as MathIRDocument["sections"] : [],
    equations: Array.isArray(raw.equations) ? raw.equations as MathIRDocument["equations"] : [],
    theorems: Array.isArray(raw.theorems) ? raw.theorems as MathIRDocument["theorems"] : [],
    figures: Array.isArray(raw.figures) ? raw.figures as MathIRDocument["figures"] : [],
    tables: Array.isArray(raw.tables) ? raw.tables as MathIRDocument["tables"] : [],
    references: Array.isArray(raw.references) ? raw.references as MathIRDocument["references"] : [],
    relations: Array.isArray(raw.relations) ? raw.relations as MathIRDocument["relations"] : [],
    metadata: raw.metadata ?? {},
  };
  store.upsertMathDocument(document.id, document.title, document.source_path, document);
  store.audit("math.document.ingested", { document_id: document.id, pages: document.pages, equations: document.equations.length, theorems: document.theorems.length, figures: document.figures.length, duration_ms: Date.now() - started });
  return { document, ingestion: { path: pdfPath, bytes: stat.size, duration_ms: Date.now() - started } };
}
