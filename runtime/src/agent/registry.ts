/**
 * Agent registry: SQLite-backed CRUD for agent descriptors.
 *
 * Agents are stored in the `agents` table (created by migration v4). All
 * timestamps are ISO-8601 UTC strings; permissions and context are persisted
 * as JSON columns.
 */
import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import {
  AGENT_STATES,
  assertAgentState,
  assertSpawnSpec,
  type AgentContext,
  type AgentDescriptor,
  type AgentPermissions,
  type AgentSpawnSpec,
  type AgentState,
} from "./agent.js";

interface AgentRow {
  id: string;
  name: string;
  type: string;
  state: string;
  parent_id: string | null;
  project_id: string | null;
  session_id: string | null;
  permissions_json: string;
  context_json: string;
  created_at: string;
  updated_at: string;
}

/** Filters accepted by {@link AgentRegistry.list}. */
export interface AgentListFilters {
  state?: AgentState;
  type?: string;
  parentId?: string;
  projectId?: string;
}

function parseJsonColumn(raw: string, field: string): Record<string, unknown> {
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
    return value as Record<string, unknown>;
  } catch {
    throw new Error(`corrupt ${field} JSON for stored agent`);
  }
}

function rowToDescriptor(row: AgentRow): AgentDescriptor {
  assertAgentState(row.state);
  const descriptor: AgentDescriptor = {
    id: row.id,
    name: row.name,
    type: row.type,
    state: row.state,
    permissions: parseJsonColumn(row.permissions_json, "permissions") as AgentPermissions,
    context: parseJsonColumn(row.context_json, "context") as AgentContext,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (row.parent_id !== null) descriptor.parentId = row.parent_id;
  if (row.project_id !== null) descriptor.projectId = row.project_id;
  if (row.session_id !== null) descriptor.sessionId = row.session_id;
  return descriptor;
}

/** Registry bound to an open SQLite connection (shares the runtime database). */
export class AgentRegistry {
  constructor(private readonly db: Database.Database) {}

  /** Insert a new agent in `created` state and return its descriptor. */
  register(spec: AgentSpawnSpec): AgentDescriptor {
    assertSpawnSpec(spec);
    const now = new Date().toISOString();
    const descriptor: AgentDescriptor = {
      id: randomUUID(),
      name: spec.name.trim(),
      type: spec.type,
      state: "created",
      permissions: spec.permissions ?? {},
      context: spec.context ?? {},
      createdAt: now,
      updatedAt: now,
    };
    if (spec.parentId !== undefined) {
      if (!this.get(spec.parentId)) throw new Error(`parent agent ${spec.parentId} does not exist`);
      descriptor.parentId = spec.parentId;
    }
    if (spec.projectId !== undefined) descriptor.projectId = spec.projectId;
    if (spec.sessionId !== undefined) descriptor.sessionId = spec.sessionId;
    this.db
      .prepare(
        `INSERT INTO agents(id,name,type,state,parent_id,project_id,session_id,permissions_json,context_json,created_at,updated_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        descriptor.id,
        descriptor.name,
        descriptor.type,
        descriptor.state,
        descriptor.parentId ?? null,
        descriptor.projectId ?? null,
        descriptor.sessionId ?? null,
        JSON.stringify(descriptor.permissions),
        JSON.stringify(descriptor.context),
        descriptor.createdAt,
        descriptor.updatedAt,
      );
    return descriptor;
  }

  /** Fetch one agent by id, or undefined when missing. */
  get(id: string): AgentDescriptor | undefined {
    const row = this.db.prepare("SELECT * FROM agents WHERE id=?").get(id) as AgentRow | undefined;
    return row ? rowToDescriptor(row) : undefined;
  }

  /** List agents matching optional filters, newest first. */
  list(filters: AgentListFilters = {}): AgentDescriptor[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filters.state !== undefined) {
      assertAgentState(filters.state);
      clauses.push("state=?");
      params.push(filters.state);
    }
    if (filters.type !== undefined) {
      clauses.push("type=?");
      params.push(filters.type);
    }
    if (filters.parentId !== undefined) {
      clauses.push("parent_id=?");
      params.push(filters.parentId);
    }
    if (filters.projectId !== undefined) {
      clauses.push("project_id=?");
      params.push(filters.projectId);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(`SELECT * FROM agents ${where} ORDER BY created_at DESC, id DESC LIMIT 1000`)
      .all(...params) as AgentRow[];
    return rows.map(rowToDescriptor);
  }

  /** Direct children of an agent (Phase B grows this into recursive trees). */
  listChildren(parentId: string): AgentDescriptor[] {
    return this.list({ parentId });
  }

  /**
   * Patch mutable fields of an agent.
   * @throws when the agent does not exist or the patch is invalid.
   */
  update(
    id: string,
    partial: Partial<Pick<AgentDescriptor, "state" | "name" | "context" | "permissions">>,
  ): AgentDescriptor {
    const current = this.get(id);
    if (!current) throw new Error(`agent ${id} does not exist`);
    const next: AgentDescriptor = { ...current, updatedAt: new Date().toISOString() };
    if (partial.state !== undefined) {
      assertAgentState(partial.state);
      next.state = partial.state;
    }
    if (partial.name !== undefined) {
      if (typeof partial.name !== "string" || !partial.name.trim()) throw new Error("agent name is required");
      next.name = partial.name.trim();
    }
    if (partial.context !== undefined) {
      if (typeof partial.context !== "object" || partial.context === null || Array.isArray(partial.context)) {
        throw new Error("context must be an object");
      }
      next.context = partial.context;
    }
    if (partial.permissions !== undefined) {
      if (typeof partial.permissions !== "object" || partial.permissions === null || Array.isArray(partial.permissions)) {
        throw new Error("permissions must be an object");
      }
      next.permissions = partial.permissions;
    }
    this.db
      .prepare(
        `UPDATE agents SET name=?,state=?,permissions_json=?,context_json=?,updated_at=? WHERE id=?`,
      )
      .run(next.name, next.state, JSON.stringify(next.permissions), JSON.stringify(next.context), next.updatedAt, id);
    return next;
  }

  /**
   * Delete an agent row. Agents with children must be deleted leaf-first;
   * this keeps parent links dangling-free without cascading surprises.
   * @returns true when a row was removed.
   */
  delete(id: string): boolean {
    if (this.listChildren(id).length > 0) throw new Error(`agent ${id} still has subagents`);
    return this.db.prepare("DELETE FROM agents WHERE id=?").run(id).changes > 0;
  }
}

/** Re-exported for convenience of server/test consumers. */
export { AGENT_STATES };
