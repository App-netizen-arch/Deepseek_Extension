import path from "node:path";
import { WORKSPACE } from "./config.js";

const SECRET_NAMES = new Set([".env", ".env.local", ".env.production", "id_rsa", "id_ed25519", "credentials.json", "token.json"]);
const ROOT = path.resolve(WORKSPACE);

export type RiskTier = "low" | "medium" | "high" | "critical";
export type PolicyDecision = "allow" | "ask" | "deny";

export const RISK_POLICY: Readonly<Record<RiskTier, PolicyDecision>> = Object.freeze({
  low: "allow",
  medium: "allow",
  high: "ask",
  critical: "deny",
});

export function policyDecision(risk: RiskTier): PolicyDecision {
  return RISK_POLICY[risk];
}

export function assertRiskAllowed(risk: RiskTier, approved = false): void {
  const decision = policyDecision(risk);
  if (decision === "deny") throw new Error(`risk tier ${risk} is not automatically executable`);
  if (decision === "ask" && !approved) throw new Error(`risk tier ${risk} requires explicit approval`);
}

export function securePath(candidate: string): string {
  const resolved = path.resolve(ROOT, candidate);
  if (resolved !== ROOT && !resolved.startsWith(`${ROOT}${path.sep}`)) throw new Error("path escapes configured workspace");
  const rel = path.relative(ROOT, resolved).replaceAll("\\", "/");
  const parts = rel.split("/").filter(Boolean);
  if (parts.some((p) => SECRET_NAMES.has(p) || p === ".git")) throw new Error("access to protected path denied");
  return resolved;
}

export function isSecretPath(candidate: string): boolean {
  try {
    securePath(candidate);
    return false;
  } catch {
    return true;
  }
}

export function secureUrl(value: string, allowLocal = false): URL {
  const url = new URL(value);
  if (url.protocol === "file:") throw new Error("file URLs are not permitted");
  if (allowLocal && (url.hostname === "127.0.0.1" || url.hostname === "localhost")) return url;
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("only HTTP(S) URLs are permitted");
  return url;
}

export function assertLoopbackUrl(value: string | URL): URL {
  const url = typeof value === "string" ? new URL(value) : value;
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") throw new Error("runtime URL must use HTTP loopback 127.0.0.1");
  return url;
}

export function assertRequestOrigin(origin: string | undefined | null, allowedOrigins: readonly string[] = []): void {
  if (!origin) return;
  if (origin === "null") throw new Error("opaque request origins are not permitted");
  const allowed = new Set(["http://127.0.0.1", "http://localhost", ...allowedOrigins]);
  if (allowed.has(origin)) return;
  if (origin.startsWith("chrome-extension://") || origin.startsWith("moz-extension://")) return;
  throw new Error("request origin is not allowed");
}

export function assertBoundAddress(host: string): void {
  if (host !== "127.0.0.1") throw new Error("runtime must bind only to 127.0.0.1");
}

export function assertBearerToken(token: string): void {
  if (!token || token.length < 32) throw new Error("runtime bearer token must be at least 32 characters");
}

export const SECURITY_LIMITS = Object.freeze({
  maxRequestBytes: 2 * 1024 * 1024,
  maxWorkspaceFileBytes: 10 * 1024 * 1024,
  maxLogBytes: 5 * 1024 * 1024,
  maxQueueDepth: 100,
  maxConcurrentJobs: 3,
});
