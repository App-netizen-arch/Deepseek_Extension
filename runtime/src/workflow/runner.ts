/**
 * Workflow runner: executes validated {@link WorkflowDefinition}s as durable,
 * observable runs persisted in the `workflow_runs` table (migration v5).
 *
 * Execution model:
 * - Steps form a DAG via `depends_on`; ready steps launch concurrently up to
 *   a per-run cap, otherwise declared order is preserved.
 * - A failed/skipped step cascades `skipped` to its dependents unless the
 *   failing step opted into `continue_on_error`.
 * - Tool steps invoke the shared permission/approval pipeline; agent steps
 *   spawn a subagent under a per-run supervisor so cancelling the run
 *   cancels every child agent and task (Phase B lifecycle binding).
 */
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { log } from "../operational.js";
import type { AgentRunner } from "../agent/runner.js";
import type { TaskQueue } from "../agent/queue.js";
import { resolveTemplates, type TemplateContext } from "./template.js";
import type { WorkflowDefinition, WorkflowStepDefinition } from "./loader.js";

export type WorkflowRunStatus = "pending" | "running" | "completed" | "failed" | "cancelled";
export type WorkflowStepStatus = "pending" | "running" | "completed" | "failed" | "skipped";

/** Persisted state of one step within a run. */
export interface StepState {
  id: string;
  status: WorkflowStepStatus;
  result?: unknown;
  error?: string;
  attempts: number;
  startedAt?: string;
  finishedAt?: string;
}

/** Full persisted run record. */
export interface WorkflowRunRecord {
  id: string;
  name: string;
  status: WorkflowRunStatus;
  definition: WorkflowDefinition;
  input: Record<string, unknown>;
  steps: Record<string, StepState>;
  /** Supervisor agent id; cancelling it cascades to all step agents. */
  agentId?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
}

/** Lifecycle events emitted while a run executes. */
export interface WorkflowEvent {
  kind:
    | "run_started"
    | "step_started"
    | "step_completed"
    | "step_failed"
    | "step_skipped"
    | "run_completed"
    | "run_failed"
    | "run_cancelled";
  runId: string;
  stepId?: string;
  detail?: string;
}

/** Callback receiving every {@link WorkflowEvent}; failures must not escape. */
export type WorkflowEventListener = (event: WorkflowEvent) => void;

/** Construction dependencies for the workflow runner. */
export interface WorkflowRunnerDeps {
  db: Database.Database;
  /** Shared tool pipeline (permission/approval enforced). */
  invokeTool: (
    caller: { agentId: string },
    toolName: string,
    params: Record<string, unknown>,
  ) => Promise<unknown>;
  /** Used to spawn the supervisor and step agents (cancellation cascade root). */
  agentRunner: AgentRunner;
  /** Task queue polled while waiting for step agents to finish. */
  agentQueue: TaskQueue;
}

/** Options for the workflow runner. */
export interface WorkflowRunnerOptions {
  /** Max concurrently executing steps per run (default 4). */
  concurrencyPerRun?: number;
  /** Poll interval when waiting on step agents in ms (default 50). */
  pollMs?: number;
  /** Fallback per-step timeout in ms (default 120000). */
  defaultStepTimeoutMs?: number;
  onEvent?: WorkflowEventListener;
}

interface RunRow {
  id: string;
  name: string;
  status: string;
  definition_json: string;
  inputs_json: string;
  step_states_json: string;
  agent_id: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
}

function rowToRecord(row: RunRow): WorkflowRunRecord {
  const record: WorkflowRunRecord = {
    id: row.id,
    name: row.name,
    status: row.status as WorkflowRunStatus,
    definition: JSON.parse(row.definition_json) as WorkflowDefinition,
    input: JSON.parse(row.inputs_json) as Record<string, unknown>,
    steps: JSON.parse(row.step_states_json) as Record<string, StepState>,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (row.agent_id !== null) record.agentId = row.agent_id;
  if (row.error !== null) record.error = row.error;
  if (row.started_at !== null) record.startedAt = row.started_at;
  if (row.finished_at !== null) record.finishedAt = row.finished_at;
  return record;
}

const TERMINAL_RUN_STATES: readonly WorkflowRunStatus[] = ["completed", "failed", "cancelled"];

export class WorkflowRunner {
  private readonly concurrency: number;
  private readonly pollMs: number;
  private readonly defaultStepTimeoutMs: number;
  private readonly onEvent?: WorkflowEventListener;
  /** Runs whose cancellation was requested while still executing. */
  private readonly cancelRequested = new Set<string>();

  private readonly insertStmt;
  private readonly setStatusStmt;
  private readonly setStepsStmt;
  private readonly getStmt;
  private readonly listStmt;

  constructor(
    private readonly deps: WorkflowRunnerDeps,
    options: WorkflowRunnerOptions = {},
  ) {
    this.concurrency = Math.max(1, Math.min(options.concurrencyPerRun ?? 4, 16));
    this.pollMs = Math.max(10, options.pollMs ?? 50);
    this.defaultStepTimeoutMs = Math.max(1000, options.defaultStepTimeoutMs ?? 120_000);
    this.onEvent = options.onEvent;
    const db = deps.db;
    this.insertStmt = db.prepare(
      `INSERT INTO workflow_runs(id,name,status,definition_json,inputs_json,step_states_json,agent_id,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?)`,
    );
    this.setStatusStmt = db.prepare(
      `UPDATE workflow_runs SET status=?, error=?, started_at=COALESCE(?,started_at),
       finished_at=CASE WHEN ? IN ('completed','failed','cancelled') THEN COALESCE(finished_at,?) ELSE finished_at END,
       updated_at=? WHERE id=?`,
    );
    this.setStepsStmt = db.prepare("UPDATE workflow_runs SET step_states_json=?, updated_at=? WHERE id=?");
    this.getStmt = db.prepare("SELECT * FROM workflow_runs WHERE id=?");
    this.listStmt = db.prepare(
      "SELECT id,name,status,created_at,updated_at,finished_at FROM workflow_runs ORDER BY updated_at DESC, id DESC LIMIT ?",
    );
  }

  private emit(event: WorkflowEvent): void {
    try {
      this.onEvent?.(event);
    } catch {
      // listener failures must never break execution
    }
  }

  /**
   * Register and asynchronously execute a workflow run.
   * @returns the run id immediately; observe progress via {@link status} or events.
   * @throws when the input is not an object.
   */
  start(definition: WorkflowDefinition, input: Record<string, unknown> = {}): { runId: string } {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("workflow input must be an object");
    const now = new Date().toISOString();
    const runId = randomUUID();
    const supervisor = this.deps.agentRunner.spawn({
      name: `workflow-${definition.name}-${runId.slice(0, 8)}`.slice(0, 120),
      type: "demo",
      context: { workflow_run_id: runId },
    }).agent;
    const steps: Record<string, StepState> = {};
    for (const step of definition.steps) {
      steps[step.id] = { id: step.id, status: "pending", attempts: 0 };
    }
    this.insertStmt.run(runId, definition.name, "pending", JSON.stringify(definition), JSON.stringify(input), JSON.stringify(steps), supervisor.id, now, now);
    void this.execute(runId, definition, input, supervisor.id);
    return { runId };
  }

  /** Execute one run to completion. Internal; exposed for tests. */
  async execute(runId: string, definition: WorkflowDefinition, input: Record<string, unknown>, supervisorId: string): Promise<void> {
    const now = new Date().toISOString();
    const record = this.get(runId)!;
    this.setStatus(record.status === "pending" ? "running" : record.status, null, now, null, runId);
    this.emit({ kind: "run_started", runId });
    log("info", "workflow run started", { runId, name: definition.name });

    const states: Record<string, StepState> = JSON.parse(JSON.stringify(record.steps));
    const running = new Map<string, Promise<void>>();
    let anyFailed = false;

    const allTerminal = () => Object.values(states).every((s) => s.status !== "pending");

    try {
      while (!allTerminal()) {
        if (this.cancelRequested.has(runId)) break;

        // Dependency resolution: a pending step is runnable when every
        // dependency completed, or terminated badly on a step that opted into
        // continue_on_error; otherwise it is skipped (cascade).
        const depRunnable = (step: WorkflowStepDefinition): boolean =>
          (step.depends_on ?? []).every((dep) => {
            const status = states[dep].status;
            if (status === "completed") return true;
            if (status === "failed" || status === "skipped") {
              return !!definition.steps.find((s) => s.id === dep)?.continue_on_error;
            }
            return false;
          });
        for (const step of definition.steps) {
          const state = states[step.id];
          if (state.status !== "pending") continue;
          if ((step.depends_on ?? []).length === 0 || depRunnable(step)) continue;
          const depsSettled = (step.depends_on ?? []).every((dep) => !["pending", "running"].includes(states[dep].status));
          if (!depsSettled) continue;
          state.status = "skipped";
          state.error = "dependency did not succeed";
          state.finishedAt = new Date().toISOString();
          this.emit({ kind: "step_skipped", runId, stepId: step.id, detail: "dependency did not succeed" });
        }
        this.persistSteps(runId, states);

        // Launch every ready step up to the concurrency cap.
        for (const step of definition.steps) {
          if (running.size >= this.concurrency) break;
          const state = states[step.id];
          if (state.status !== "pending") continue;
          if (!depRunnable(step)) continue;
          const promise = this.runStep(runId, step, states, input, supervisorId).finally(() => running.delete(step.id));
          running.set(step.id, promise);
        }

        if (running.size === 0) {
          if (Object.values(states).some((s) => s.status === "pending")) {
            await sleep(this.pollMs); // waiting on skips/cancellations to settle
            continue;
          }
          break;
        }
        // Wake promptly on cancellation instead of blocking on in-flight work.
        const cancellationWatcher = (async () => {
          while (!this.cancelRequested.has(runId)) await sleep(this.pollMs);
        })();
        await Promise.race([Promise.race(running.values()), cancellationWatcher]);
      }

      await Promise.allSettled([...running.values()]);
      anyFailed = Object.values(states).some((s) => s.status === "failed");

      if (this.cancelRequested.has(runId)) {
        this.finalize(runId, "cancelled", states, "run cancelled");
      } else if (anyFailed) {
        this.finalize(runId, "failed", states, "one or more steps failed");
      } else {
        this.finalize(runId, "completed", states, undefined);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.finalize(runId, "failed", states, message);
      log("error", "workflow run crashed", { runId, error: message });
    } finally {
      this.persistSteps(runId, states);
      this.cancelRequested.delete(runId);
    }
  }

  /** Execute a single step including its retry budget. */
  private async runStep(
    runId: string,
    step: WorkflowStepDefinition,
    states: Record<string, StepState>,
    input: Record<string, unknown>,
    supervisorId: string,
  ): Promise<void> {
    const state = states[step.id];
    state.status = "running";
    state.startedAt = new Date().toISOString();
    this.emit({ kind: "step_started", runId, stepId: step.id });
    this.persistSteps(runId, states);

    const maxAttempts = (step.retries ?? 0) + 1;
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (this.cancelRequested.has(runId)) {
        state.status = "failed";
        state.error = "run cancelled during step";
        return;
      }
      state.attempts = attempt;
      try {
        // Conditional branch: falsy `when` skips the step entirely.
        if (step.when !== undefined) {
          const condition = resolveTemplates(step.when, this.templateContext(input, states));
          if (!condition) {
            state.status = "skipped";
            state.result = undefined;
            delete state.error;
            state.finishedAt = new Date().toISOString();
            this.emit({ kind: "step_skipped", runId, stepId: step.id, detail: "when-condition evaluated falsy" });
            this.persistSteps(runId, states);
            return;
          }
        }
        const params = resolveTemplates(step.params ?? {}, this.templateContext(input, states));
        const timeoutMs = step.timeout_ms ?? this.defaultStepTimeoutMs;
        const result =
          step.type === "tool"
            ? await withTimeout(
                this.deps.invokeTool({ agentId: supervisorId }, step.target, params as Record<string, unknown>),
                timeoutMs,
                `tool ${step.target}`,
              )
            : await this.runAgentStep(runId, step, params as Record<string, unknown>, supervisorId, timeoutMs);
        state.status = "completed";
        state.result = result;
        delete state.error;
        state.finishedAt = new Date().toISOString();
        this.emit({ kind: "step_completed", runId, stepId: step.id });
        this.persistSteps(runId, states);
        log("info", "workflow step completed", { runId, stepId: step.id, attempts: attempt });
        return;
      } catch (error) {
        lastError = error;
        log("warn", "workflow step attempt failed", {
          runId,
          stepId: step.id,
          attempt,
          willRetry: attempt < maxAttempts,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    state.status = "failed";
    state.error = lastError instanceof Error ? lastError.message : String(lastError);
    state.finishedAt = new Date().toISOString();
    this.emit({ kind: "step_failed", runId, stepId: step.id, detail: state.error });
    this.persistSteps(runId, states);
  }

  /** Spawn a subagent under the run supervisor and await its bootstrap task. */
  private async runAgentStep(
    runId: string,
    step: WorkflowStepDefinition,
    payload: Record<string, unknown>,
    supervisorId: string,
    timeoutMs: number,
  ): Promise<unknown> {
    const deadline = Date.now() + timeoutMs;
    const spawned = this.deps.agentRunner.spawn(
      { name: `wf-${step.id}`.slice(0, 120), type: step.target, parentId: supervisorId },
      { task: payload },
    );
    for (;;) {
      if (this.cancelRequested.has(runId)) throw new Error("run cancelled during agent step");
      const record = this.deps.agentQueue.get(spawned.task!.id);
      if (!record) throw new Error(`step task ${spawned.task!.id} vanished`);
      if (record.status === "completed") return record.result;
      if (record.status === "failed") throw new Error(record.error ?? "agent step failed");
      if (record.status === "cancelled") throw new Error("agent step cancelled");
      if (Date.now() > deadline) throw new Error(`agent step timed out after ${timeoutMs}ms`);
      await sleep(this.pollMs);
    }
  }

  private templateContext(input: Record<string, unknown>, states: Record<string, StepState>): TemplateContext {
    const steps: TemplateContext["steps"] = {};
    for (const [id, state] of Object.entries(states)) {
      steps[id] = { status: state.status, ...(state.result !== undefined ? { result: state.result } : {}) };
    }
    return { input, steps };
  }

  /** Request cancellation: aborts scheduling and cancels the whole subtree. */
  cancel(runId: string): boolean {
    const record = this.get(runId);
    if (!record || TERMINAL_RUN_STATES.includes(record.status)) return false;
    this.cancelRequested.add(runId);
    if (record.agentId) this.deps.agentRunner.cancel(record.agentId); // cascades to children
    this.setStatus("cancelled", "cancelled by request", null, new Date().toISOString(), runId);
    this.emit({ kind: "run_cancelled", runId });
    log("info", "workflow run cancelled", { runId });
    return true;
  }

  /** Fetch one run record with parsed definition/steps. */
  get(runId: string): WorkflowRunRecord | undefined {
    const row = this.getStmt.get(runId) as RunRow | undefined;
    return row ? rowToRecord(row) : undefined;
  }

  /** Summaries of recent runs, newest first. */
  listRuns(limit = 50): Array<Pick<WorkflowRunRecord, "id" | "name" | "status"> & { updatedAt: string; finishedAt?: string }> {
    const rows = this.listStmt.all(Math.min(limit, 200)) as Array<RunRow>;
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      status: row.status as WorkflowRunStatus,
      updatedAt: row.updated_at,
      ...(row.finished_at !== null ? { finishedAt: row.finished_at } : {}),
    }));
  }

  private finalize(runId: string, status: Exclude<WorkflowRunStatus, "pending" | "running">, states: Record<string, StepState>, error?: string): void {
    const now = new Date().toISOString();
    this.setStatus(status, error ?? null, null, now, runId);
    this.persistSteps(runId, states);
    const kinds = { completed: "run_completed", failed: "run_failed", cancelled: "run_cancelled" } as const;
    this.emit({ kind: kinds[status], runId, detail: error });
    log(status === "completed" ? "info" : "error", "workflow run finished", { runId, status, error });
  }

  private setStatus(status: string, error: string | null, startedAt: string | null, finishedAt: string | null, runId: string): void {
    // startedAt only on the initial running transition (SQL COALESCE keeps
    // the existing value when null); finishedAt only on terminal states.
    this.setStatusStmt.run(status, error, startedAt, status, finishedAt, new Date().toISOString(), runId);
  }

  private persistSteps(runId: string, states: Record<string, StepState>): void {
    this.setStepsStmt.run(JSON.stringify(states), new Date().toISOString(), runId);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
