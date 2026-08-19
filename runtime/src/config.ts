import path from "node:path";

export const HOST = "127.0.0.1";
export const PORT = Number(process.env.BDS_RUNTIME_PORT ?? 3037);
export const TOKEN = String(process.env.BDS_RUNTIME_TOKEN ?? "").trim();
export const DB_PATH = process.env.BDS_RUNTIME_DB ?? "./data/runtime.db";
export const WORKSPACE = path.resolve(process.env.BDS_WORKSPACE ?? process.cwd());

export const LIMITS = {
  wsMessageBytes: 256 * 1024,
  httpBodyBytes: 512 * 1024,
  auditPayloadBytes: 64 * 1024,
  maxAuditRows: 10000,
  maxMemoryBytes: 2 * 1024 * 1024 * 1024,
  maxConcurrentJobs: 3,
};

export function assertConfiguration(): void {
  if (!Number.isInteger(PORT) || PORT < 1024 || PORT > 65535) {
    throw new Error("BDS_RUNTIME_PORT must be an integer between 1024 and 65535");
  }
  if (!TOKEN || TOKEN.length < 32) {
    throw new Error("BDS_RUNTIME_TOKEN is required and must be at least 32 characters");
  }
}
