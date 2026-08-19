export const HOST = "127.0.0.1";
export const PORT = Number(process.env.BDS_RUNTIME_PORT ?? 3037);
export const TOKEN = String(process.env.BDS_RUNTIME_TOKEN ?? "").trim();
export const DB_PATH = process.env.BDS_RUNTIME_DB ?? "./data/runtime.db";

export const LIMITS = {
  wsMessageBytes: 256 * 1024,
  httpBodyBytes: 256 * 1024,
  auditPayloadBytes: 64 * 1024,
  maxAuditRows: 10000,
};

export function assertConfiguration(): void {
  if (!Number.isInteger(PORT) || PORT < 1024 || PORT > 65535) {
    throw new Error("BDS_RUNTIME_PORT must be an integer between 1024 and 65535");
  }
  if (!TOKEN || TOKEN.length < 32) {
    throw new Error("BDS_RUNTIME_TOKEN is required and must be at least 32 characters");
  }
}
