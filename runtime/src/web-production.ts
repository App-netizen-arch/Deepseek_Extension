import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium, type BrowserContext } from "playwright";
import type { RuntimeStore } from "./store.js";
import { WORKSPACE } from "./config.js";

export type InteractionLevel = "read-only" | "click" | "fill-forms";
export type TaskStatus = "queued" | "running" | "paused" | "completed" | "cancelled" | "failed";

export interface ProductionWebTaskRequest {
  goal: string;
  start_url?: string;
  max_pages?: number;
  max_depth?: number;
  time_budget_minutes?: number;
  interaction_level?: InteractionLevel;
  session_name?: string;
  allowed_domains?: string[];
  blocked_domains?: string[];
  resume_task_id?: string;
}

export interface ApprovalRequest {
  id: string;
  task_id: string;
  action: "fill-form" | "submit-form" | "click-high-risk";
  target: string;
  expires_at: string;
  status: "pending" | "approved" | "denied" | "expired";
}

interface Control {
  paused: boolean;
  cancelled: boolean;
  waiters: Array<() => void>;
}

const controls = new Map<string, Control>();
const sessionContexts = new Map<string, BrowserContext>();
const MAX_SESSION_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function secretKey(): Buffer {
  const material = process.env.BDS_SESSION_KEY || process.env.BDS_RUNTIME_TOKEN || "";
  if (!material) throw new Error("BDS_SESSION_KEY or BDS_RUNTIME_TOKEN is required for encrypted sessions");
  return crypto.createHash("sha256").update(material).digest();
}

function encrypt(value: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", secretKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString("base64url");
}

function decrypt(value: string): string {
  const raw = Buffer.from(value, "base64url");
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const ciphertext = raw.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", secretKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

function normalizeDomains(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.filter((value): value is string => typeof value === "string").map((value) => value.trim().toLowerCase()).filter(Boolean))].slice(0, 100);
}

export function normalizeProductionRequest(request: ProductionWebTaskRequest): Required<Pick<ProductionWebTaskRequest, "goal" | "max_pages" | "max_depth" | "time_budget_minutes" | "interaction_level">> & Pick<ProductionWebTaskRequest, "start_url" | "session_name" | "allowed_domains" | "blocked_domains" | "resume_task_id"> {
  if (!request || typeof request.goal !== "string" || !request.goal.trim()) throw new Error("goal is required");
  const maxPages = Number.isFinite(request.max_pages) ? Math.floor(request.max_pages!) : 25;
  const maxDepth = Number.isFinite(request.max_depth) ? Math.floor(request.max_depth!) : 3;
  const timeBudget = Number.isFinite(request.time_budget_minutes) ? Math.floor(request.time_budget_minutes!) : 20;
  const interaction = request.interaction_level ?? "read-only";
  if (!["read-only", "click", "fill-forms"].includes(interaction)) throw new Error("invalid interaction level");
  return {
    goal: request.goal.trim(),
    start_url: request.start_url,
    max_pages: Math.max(1, Math.min(25, maxPages)),
    max_depth: Math.max(0, Math.min(3, maxDepth)),
    time_budget_minutes: Math.max(1, Math.min(20, timeBudget)),
    interaction_level: interaction,
    session_name: request.session_name,
    allowed_domains: normalizeDomains(request.allowed_domains),
    blocked_domains: normalizeDomains(request.blocked_domains),
    resume_task_id: request.resume_task_id,
  };
}

export function domainAllowed(hostname: string, allowed: string[], blocked: string[]): boolean {
  const host = hostname.toLowerCase();
  if (blocked.some((domain) => host === domain || host.endsWith(`.${domain}`))) return false;
  if (!allowed.length) return true;
  return allowed.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

export function createControl(taskId: string): Control {
  const control: Control = { paused: false, cancelled: false, waiters: [] };
  controls.set(taskId, control);
  return control;
}

export function getControl(taskId: string): Control | undefined { return controls.get(taskId); }

export function pauseTask(taskId: string): boolean {
  const control = controls.get(taskId);
  if (!control) return false;
  control.paused = true;
  return true;
}

export function resumeTask(taskId: string): boolean {
  const control = controls.get(taskId);
  if (!control) return false;
  control.paused = false;
  for (const resolve of control.waiters.splice(0)) resolve();
  return true;
}

export function cancelTask(taskId: string): boolean {
  const control = controls.get(taskId);
  if (!control) return false;
  control.cancelled = true;
  control.paused = false;
  for (const resolve of control.waiters.splice(0)) resolve();
  return true;
}

export async function waitForResume(taskId: string): Promise<void> {
  const control = controls.get(taskId);
  if (!control) throw new Error("task control not found");
  if (!control.paused) return;
  await new Promise<void>((resolve) => control.waiters.push(resolve));
}

export function clearControl(taskId: string): void { controls.delete(taskId); }

export async function createLoginSession(name: string): Promise<{ id: string; name: string; expires_at: string }> {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(name)) throw new Error("invalid session name");
  const existing = await listSessions();
  if (existing.some((session) => session.name === name)) throw new Error("session already exists");
  const context = await chromium.launchPersistentContext(path.join(WORKSPACE, ".better-deepseek", "sessions", name, "browser"), { headless: false });
  sessionContexts.set(name, context);
  return { id: name, name, expires_at: new Date(Date.now() + MAX_SESSION_AGE_MS).toISOString() };
}

export async function saveLoginSession(name: string, store: RuntimeStore): Promise<void> {
  const context = sessionContexts.get(name);
  if (!context) throw new Error("session is not open");
  const state = await context.storageState();
  store.upsertWebSession(name, encrypt(JSON.stringify(state)), new Date(Date.now() + MAX_SESSION_AGE_MS).toISOString());
  await context.close();
  sessionContexts.delete(name);
  store.audit("web.session.saved", { name });
}

export async function deleteSession(name: string, store: RuntimeStore): Promise<boolean> {
  const context = sessionContexts.get(name);
  if (context) {
    await context.close().catch(() => undefined);
    sessionContexts.delete(name);
  }
  const removed = store.deleteWebSession(name);
  if (removed) store.audit("web.session.deleted", { name });
  return removed;
}

export async function listSessions(): Promise<Array<{ id: string; name: string; expires_at: string }>> {
  const entries: Array<{ id: string; name: string; expires_at: string }> = [];
  const root = path.join(WORKSPACE, ".better-deepseek", "sessions");
  try {
    const names = await fs.readdir(root, { withFileTypes: true });
    for (const entry of names) {
      if (!entry.isDirectory()) continue;
      entries.push({ id: entry.name, name: entry.name, expires_at: new Date(Date.now() + MAX_SESSION_AGE_MS).toISOString() });
    }
  } catch {
    // Directory may not exist yet.
  }
  return entries;
}

export async function launchSessionContext(name: string): Promise<BrowserContext> {
  const stored = (await import("./store.js")).RuntimeStore;
  void stored;
  throw new Error("use loadSessionContext(store, name)");
}

export async function loadSessionContext(store: RuntimeStore, name: string): Promise<BrowserContext> {
  const encrypted = store.getWebSession(name);
  if (!encrypted) throw new Error("session not found");
  const json = decrypt(encrypted.state_ciphertext);
  const state = JSON.parse(json) as Parameters<typeof chromium.launch>[0];
  return chromium.launch({ headless: true }).then(async (browser) => {
    const context = await browser.newContext({ storageState: state });
    (context as BrowserContext & { __bdsBrowser?: unknown }).__bdsBrowser = browser;
    return context;
  });
}

export async function closeLoadedContext(context: BrowserContext): Promise<void> {
  await context.close();
  const browser = (context as BrowserContext & { __bdsBrowser?: { close: () => Promise<void> } }).__bdsBrowser;
  await browser?.close().catch(() => undefined);
}
