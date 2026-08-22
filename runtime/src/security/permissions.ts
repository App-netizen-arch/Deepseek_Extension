/**
 * Permission engine: fine-grained, expiring rules that override the default
 * risk policy per (agent, tool, resource-glob).
 *
 * Evaluation contract for {@link checkPermission}:
 * - Only non-expired rules matching the request participate.
 * - A rule matches when its `agentId` is unset (global), equal to the
 *   requesting agent, its `tool` equals the requested tool (or "*"), and —
 *   when the rule carries a `pathPattern` — the resource satisfies that glob.
 * - Among matching rules the strictest decision wins: deny > ask > allow.
 * - No match returns undefined so callers fall back to the shared risk tier.
 *
 * Rules are the consent mechanism of record: an explicit `allow` rule lets a
 * HIGH action run unattended and is the only way a CRITICAL tool executes at
 * all ("denied by default; overridable with explicit user consent").
 */
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { globMatch } from "../agent-config.js";

export type PermissionDecision = "allow" | "deny" | "ask";

/** A persisted permission rule (table `permissions`, migration v6). */
export interface PermissionRuleRecord {
  id: string;
  /** Undefined = applies to every agent. */
  agentId?: string;
  /** Tool name, or "*" for every tool. */
  tool: string;
  /** Glob applied to the resource (path/URL); undefined = resource-agnostic. */
  pathPattern?: string;
  decision: PermissionDecision;
  grantedBy: string;
  /** ISO timestamp; undefined = never expires. */
  expiresAt?: string;
  createdAt: string;
}

/** Input accepted by {@link PermissionStore.add}. */
export interface PermissionRuleSpec {
  agentId?: string;
  tool: string;
  pathPattern?: string;
  decision: PermissionDecision;
  grantedBy?: string;
  /** Lifetime in seconds; omit for a non-expiring rule. */
  ttlSeconds?: number;
}

interface RuleRow {
  id: string;
  agent_id: string | null;
  tool: string;
  path_pattern: string | null;
  decision: string;
  granted_by: string;
  expires_at: string | null;
  created_at: string;
}

function rowToRecord(row: RuleRow): PermissionRuleRecord {
  const record: PermissionRuleRecord = {
    id: row.id,
    tool: row.tool,
    decision: row.decision as PermissionDecision,
    grantedBy: row.granted_by,
    createdAt: row.created_at,
  };
  if (row.agent_id !== null) record.agentId = row.agent_id;
  if (row.path_pattern !== null) record.pathPattern = row.path_pattern;
  if (row.expires_at !== null) record.expiresAt = row.expires_at;
  return record;
}

function isExpired(rule: Pick<PermissionRuleRecord, "expiresAt">, now = Date.now()): boolean {
  return rule.expiresAt !== undefined && Date.parse(rule.expiresAt) <= now;
}

/**
 * Pure evaluation: strictest matching decision among active rules,
 * or undefined when no rule applies (caller falls back to risk tier).
 */
export function checkPermission(
  rules: readonly PermissionRuleRecord[],
  request: { agentId: string; tool: string; resource?: string },
): PermissionDecision | undefined {
  let best: PermissionDecision | undefined;
  const rank: Record<PermissionDecision, number> = { allow: 1, ask: 2, deny: 3 };
  for (const rule of rules) {
    if (isExpired(rule)) continue;
    if (rule.tool !== "*" && rule.tool !== request.tool) continue;
    if (rule.agentId !== undefined && rule.agentId !== request.agentId) continue;
    if (rule.pathPattern !== undefined) {
      if (request.resource === undefined || !globMatch(rule.pathPattern, request.resource)) continue;
    }
    if (best === undefined || rank[rule.decision] > rank[best]) best = rule.decision;
  }
  return best;
}

/** SQLite-backed store for permission rules. */
export class PermissionStore {
  constructor(private readonly db: Database.Database) {}

  /**
   * Persist a rule.
   * @throws on invalid decisions/tools or malformed patterns.
   */
  add(spec: PermissionRuleSpec): PermissionRuleRecord {
    if (!["allow", "deny", "ask"].includes(spec.decision)) throw new Error("decision must be allow, deny, or ask");
    if (typeof spec.tool !== "string" || !spec.tool.trim()) throw new Error("tool is required");
    if (!/^[a-z*][a-z0-9_.:/-]{0,127}$/.test(spec.tool)) throw new Error(`invalid tool pattern: ${spec.tool}`);
    const now = new Date();
    const record: PermissionRuleRecord = {
      id: randomUUID(),
      tool: spec.tool === "*" ? "*" : spec.tool,
      decision: spec.decision,
      grantedBy: spec.grantedBy?.trim() || "user",
      createdAt: now.toISOString(),
    };
    if (spec.agentId !== undefined && spec.agentId.trim()) record.agentId = spec.agentId.trim();
    if (spec.pathPattern !== undefined && spec.pathPattern.trim()) {
      // Validate the glob compiles before persisting.
      globMatch(spec.pathPattern, "");
      record.pathPattern = spec.pathPattern.trim();
    }
    if (spec.ttlSeconds !== undefined) {
      if (!Number.isFinite(spec.ttlSeconds) || spec.ttlSeconds <= 0) throw new Error("ttlSeconds must be positive");
      record.expiresAt = new Date(now.getTime() + spec.ttlSeconds * 1000).toISOString();
    }
    this.db
      .prepare("INSERT INTO permissions(id,agent_id,tool,path_pattern,decision,granted_by,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?)")
      .run(record.id, record.agentId ?? null, record.tool, record.pathPattern ?? null, record.decision, record.grantedBy, record.expiresAt ?? null, record.createdAt);
    return record;
  }

  /** All rules, optionally filtered; expired rows are pruned first. */
  list(filters: { agentId?: string; tool?: string } = {}): PermissionRuleRecord[] {
    this.pruneExpired();
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filters.agentId !== undefined) {
      clauses.push("(agent_id IS NULL OR agent_id=?)");
      params.push(filters.agentId);
    }
    if (filters.tool !== undefined) {
      clauses.push("tool IN (?, '*')");
      params.push(filters.tool);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db.prepare(`SELECT * FROM permissions ${where} ORDER BY created_at DESC`).all(...params) as RuleRow[];
    return rows.map(rowToRecord);
  }

  /** Remove one rule. @returns true when a row was deleted. */
  revoke(id: string): boolean {
    return this.db.prepare("DELETE FROM permissions WHERE id=?").run(id).changes > 0;
  }

  /** Lazily delete expired rules. @returns number removed. */
  pruneExpired(): number {
    return this.db.prepare("DELETE FROM permissions WHERE expires_at IS NOT NULL AND expires_at<=?").run(new Date().toISOString()).changes;
  }
}
