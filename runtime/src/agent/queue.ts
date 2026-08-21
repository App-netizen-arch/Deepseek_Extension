/**
 * Durable task queue backed by the `tasks` table (migration v4).
 *
 * Ordering contract for {@link TaskQueue.dequeue}: highest priority first
 * (`priority` 10 = highest, 1 = lowest), oldest scheduled first within the
 * same priority. Claims are transactional so concurrent consumers cannot
 * double-run a task.
 */
import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { SECURITY_LIMITS } from "../security-policy.js";

/** Lifecycle of a queued task. */
export type TaskStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export const TASK_STATUSES: readonly TaskStatus[] = Object.freeze([
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
]);

/** Persisted task record. */
export interface TaskRecord {
  id: string;
  agentId: string;
  type: string;
  payload: Record<string, unknown>;
  /** 1 (lowest) .. 10 (highest). */
  priority: number;
  status: TaskStatus;
  retries: number;
  maxRetries: number;
  scheduledAt: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  result?: unknown;
}

/** Input accepted by {@link TaskQueue.enqueue}. */
export interface TaskSpec {
  agentId: string;
  type: string;
  payload?: Record<string, unknown>;
  priority?: number;
  maxRetries?: number;
}

interface TaskRow {
  id: string;
  agent_id: string;
  type: string;
  payload_json: string;
  priority: number;
  status: string;
  retries: number;
  max_retries: number;
  scheduled_at: string;
  started_at: string | null;
  finished_at: string | null;
  error: string | null;
  result_json: string | null;
}

function rowToRecord(row: TaskRow): TaskRecord {
  const record: TaskRecord = {
    id: row.id,
    agentId: row.agent_id,
    type: row.type,
    payload: JSON.parse(row.payload_json) as Record<string, unknown>,
    priority: row.priority,
    status: row.status as TaskStatus,
    retries: row.retries,
    maxRetries: row.max_retries,
    scheduledAt: row.scheduled_at,
  };
  if (row.started_at !== null) record.startedAt = row.started_at;
  if (row.finished_at !== null) record.finishedAt = row.finished_at;
  if (row.error !== null) record.error = row.error;
  if (row.result_json !== null) record.result = JSON.parse(row.result_json);
  return record;
}

const MIN_PRIORITY = 1;
const MAX_PRIORITY = 10;
const MAX_RETRIES = 10;

/** Queue bound to an open SQLite connection (shares the runtime database). */
export class TaskQueue {
  constructor(private readonly db: Database.Database) {}

  /**
   * Insert a new queued task.
   * @throws on invalid specs or when the queue is at capacity.
   */
  enqueue(spec: TaskSpec): TaskRecord {
    if (typeof spec.agentId !== "string" || !spec.agentId.trim()) throw new Error("task agentId is required");
    if (typeof spec.type !== "string" || !spec.type.trim()) throw new Error("task type is required");
    const priority = spec.priority ?? 5;
    if (!Number.isInteger(priority) || priority < MIN_PRIORITY || priority > MAX_PRIORITY) {
      throw new Error(`task priority must be an integer between ${MIN_PRIORITY} and ${MAX_PRIORITY}`);
    }
    const maxRetries = spec.maxRetries ?? 3;
    if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > MAX_RETRIES) {
      throw new Error(`task maxRetries must be an integer between 0 and ${MAX_RETRIES}`);
    }
    const payload = spec.payload ?? {};
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
      throw new Error("task payload must be an object");
    }
    const queued = this.db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE status='queued'").get() as { count: number };
    if (queued.count >= SECURITY_LIMITS.maxQueueDepth) {
      throw new Error(`task queue is full (limit ${SECURITY_LIMITS.maxQueueDepth})`);
    }
    const record: TaskRecord = {
      id: randomUUID(),
      agentId: spec.agentId,
      type: spec.type,
      payload,
      priority,
      status: "queued",
      retries: 0,
      maxRetries,
      scheduledAt: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO tasks(id,agent_id,type,payload_json,priority,status,retries,max_retries,scheduled_at)
         VALUES(?,?,?,?,?,?,?,?,?)`,
      )
      .run(record.id, record.agentId, record.type, JSON.stringify(record.payload), record.priority, record.status, record.retries, record.maxRetries, record.scheduledAt);
    return record;
  }

  /**
   * Claim the next runnable task: highest priority, then oldest.
   * Marks it `running` and stamps `startedAt`.
   *
   * @param excludeAgentIds agent ids whose tasks must be left untouched
   *   (e.g. already executing or paused agents).
   */
  dequeue(excludeAgentIds: readonly string[] = []): TaskRecord | undefined {
    const claim = this.db.transaction((): TaskRecord | undefined => {
      let row: TaskRow | undefined;
      if (excludeAgentIds.length === 0) {
        row = this.db
          .prepare(
            `SELECT * FROM tasks WHERE status='queued'
             ORDER BY priority DESC, scheduled_at ASC, id ASC LIMIT 1`,
          )
          .get() as TaskRow | undefined;
      } else {
        const placeholders = excludeAgentIds.map(() => "?").join(",");
        row = this.db
          .prepare(
            `SELECT * FROM tasks WHERE status='queued' AND agent_id NOT IN (${placeholders})
             ORDER BY priority DESC, scheduled_at ASC, id ASC LIMIT 1`,
          )
          .get(...excludeAgentIds) as TaskRow | undefined;
      }
      if (!row) return undefined;
      const now = new Date().toISOString();
      this.db.prepare("UPDATE tasks SET status='running', started_at=? WHERE id=? AND status='queued'").run(now, row.id);
      return rowToRecord({ ...row, status: "running", started_at: now });
    });
    return claim();
  }

  /** Mark a running task completed, optionally recording its result. */
  ack(id: string, result?: unknown): boolean {
    const now = new Date().toISOString();
    const resultJson = result === undefined ? null : JSON.stringify(result);
    return (
      this.db
        .prepare("UPDATE tasks SET status='completed', finished_at=?, result_json=?, error=NULL WHERE id=? AND status='running'")
        .run(now, resultJson, id).changes > 0
    );
  }

  /**
   * Report a failed attempt. Retries up to `maxRetries` times (the task
   * returns to the queue with a fresh schedule time); otherwise marks it
   * permanently `failed`.
   */
  nack(id: string, error: unknown): TaskRecord | undefined {
    const message = error instanceof Error ? error.message : String(error ?? "unknown error");
    return this.db.transaction((): TaskRecord | undefined => {
      const row = this.db.prepare("SELECT * FROM tasks WHERE id=?").get(id) as TaskRow | undefined;
      if (!row || row.status !== "running") return undefined;
      const retries = row.retries + 1;
      const now = new Date().toISOString();
      if (retries <= row.max_retries) {
        this.db
          .prepare("UPDATE tasks SET status='queued', retries=?, scheduled_at=?, error=? WHERE id=?")
          .run(retries, now, message, id);
      } else {
        this.db
          .prepare("UPDATE tasks SET status='failed', retries=?, finished_at=?, error=? WHERE id=?")
          .run(retries, now, message, id);
      }
      const updated = this.db.prepare("SELECT * FROM tasks WHERE id=?").get(id) as TaskRow;
      return rowToRecord(updated);
    })();
  }

  /** Return a queued/running task to the queue without consuming a retry. */
  requeue(id: string): boolean {
    const now = new Date().toISOString();
    return (
      this.db
        .prepare("UPDATE tasks SET status='queued', scheduled_at=?, started_at=NULL WHERE id=? AND status IN ('queued','running')")
        .run(now, id).changes > 0
    );
  }

  /**
   * Permanently fail a non-terminal task, bypassing the retry budget.
   * Used for stale or cancelled work that must never re-run.
   */
  failTask(id: string, error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error ?? "unknown error");
    const now = new Date().toISOString();
    return (
      this.db
        .prepare("UPDATE tasks SET status='failed', finished_at=?, error=? WHERE id=? AND status IN ('queued','running')")
        .run(now, message, id).changes > 0
    );
  }

  /** Fetch one task by id, or undefined when missing. */
  get(id: string): TaskRecord | undefined {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id=?").get(id) as TaskRow | undefined;
    return row ? rowToRecord(row) : undefined;
  }

  /** List tasks newest-scheduled first, optionally filtered. */
  list(filters: { agentId?: string; status?: TaskStatus } = {}, limit = 200): TaskRecord[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filters.agentId !== undefined) {
      clauses.push("agent_id=?");
      params.push(filters.agentId);
    }
    if (filters.status !== undefined) {
      if (!TASK_STATUSES.includes(filters.status)) throw new Error(`invalid task status: ${filters.status}`);
      clauses.push("status=?");
      params.push(filters.status);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(`SELECT * FROM tasks ${where} ORDER BY scheduled_at DESC, id DESC LIMIT ?`)
      .all(...params, Math.min(limit, 1000)) as TaskRow[];
    return rows.map(rowToRecord);
  }

  /**
   * Cancel every non-terminal task belonging to an agent (lifecycle
   * binding). Covers both queued and claimed-but-running rows; the abort
   * path in the runner becomes a no-op for already-cancelled tasks.
   */
  cancelByAgent(agentId: string): number {
    const now = new Date().toISOString();
    return this.db
      .prepare("UPDATE tasks SET status='cancelled', finished_at=? WHERE agent_id=? AND status IN ('queued','running')")
      .run(now, agentId).changes;
  }

  /** Number of tasks currently waiting to run. */
  depth(): number {
    return (this.db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE status='queued'").get() as { count: number }).count;
  }
}
