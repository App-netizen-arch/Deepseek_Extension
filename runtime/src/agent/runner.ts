/**
 * Agent runner: drives agents through their lifecycle by claiming tasks from
 * the {@link TaskQueue} and executing them with {@link Agent} instances.
 *
 * The runner is the single writer of persisted agent state. Every state
 * change on the in-memory instance is mirrored into the registry, and every
 * transition is emitted as an event so the server layer can broadcast it to
 * connected WebSocket clients.
 */
import { log } from "../operational.js";
import { SECURITY_LIMITS } from "../security-policy.js";
import type { Agent, AgentDescriptor, AgentPermissions, AgentSpawnSpec, AgentState } from "./agent.js";
import type { AgentFactory } from "./demo-agent.js";
import { agentDepth, DEFAULT_MAX_SUBAGENTS, MAX_SUBAGENT_DEPTH, restrictPermissions } from "./permissions.js";
import { buildSystemPrompt, skillAppliesTo, type Skill } from "./skill-loader.js";
import type { AgentRegistry } from "./registry.js";
import type { TaskQueue, TaskRecord } from "./queue.js";

/** Emitted for every agent lifecycle occurrence. */
export interface AgentEvent {
  kind:
    | "spawned"
    | "start_requested"
    | "state"
    | "task_completed"
    | "task_failed"
    | "paused"
    | "resumed"
    | "cancelled";
  agentId: string;
  /** Resulting agent state (for `state` and terminal events). */
  state?: AgentState;
  taskId?: string;
  detail?: string;
  result?: unknown;
}

/** Callback invoked for every {@link AgentEvent}; errors must not escape. */
export type AgentEventListener = (event: AgentEvent) => void;

/** Options accepted by the runner constructor. */
export interface RunnerOptions {
  /** Maximum simultaneously executing agent tasks. Defaults to the shared job limit. */
  concurrency?: number;
  /** Listener receiving lifecycle events (used by the server for WS broadcast). */
  onEvent?: AgentEventListener;
  /**
   * Tool pipeline bridge. When provided, every launched agent can invoke
   * tools via `callTool`; invocations flow through the permission/approval
   * service chosen by the host (see `mcp/service.ts`).
   */
  toolInvoker?: (
    caller: { agentId: string; permissions: AgentPermissions; taskId: string; signal: AbortSignal },
    toolName: string,
    params: Record<string, unknown>,
  ) => Promise<unknown>;
  /**
   * Skill source consulted at spawn time (synchronous, backed by an
   * in-memory cache refreshed via `POST /v1/skills/reload`). Matching skills
   * are recorded in the agent's persisted `context.skills` array and their
   * bodies composed into the instance's system prompt at launch.
   */
  skillProvider?: () => readonly Skill[];
}

interface LiveEntry {
  agent: Agent;
  task: TaskRecord;
  promise: Promise<void>;
}

/** Snapshot returned by {@link AgentRunner.status}. */
export interface AgentStatusSnapshot {
  agent: AgentDescriptor;
  currentTask?: TaskRecord;
  recentTasks: TaskRecord[];
  /** Ids of direct subagents. */
  children: string[];
}

/** Options accepted by {@link AgentRunner.spawn}. */
export interface SpawnOptions {
  /** Bootstrap task payload enqueued for the new agent (implies autostart). */
  task?: Record<string, unknown>;
  /** Priority for the bootstrap task (1–10, default 5). */
  priority?: number;
}

/** Result of a successful spawn. */
export interface SpawnResult {
  agent: AgentDescriptor;
  /** Present when a bootstrap task was enqueued via {@link SpawnOptions.task}. */
  task?: TaskRecord;
}

/**
 * Orchestrates spawn -> start -> plan -> execute -> complete/failed/cancelled.
 * Also owns cooperative pause/resume and cancellation of queued work.
 */
export class AgentRunner {
  private readonly live = new Map<string, LiveEntry>();
  private readonly concurrency: number;
  private readonly onEvent?: AgentEventListener;
  private readonly toolInvoker?: NonNullable<RunnerOptions["toolInvoker"]>;
  private readonly skillProvider?: NonNullable<RunnerOptions["skillProvider"]>;
  /** Skills resolved during spawn, consumed by launch for prompt injection. */
  private readonly spawnedSkills = new Map<string, readonly Skill[]>();
  private ticking = false;
  private pendingOperations = 0;
  private readonly idleWaiters: Array<() => void> = [];

  constructor(
    private readonly registry: AgentRegistry,
    private readonly queue: TaskQueue,
    private readonly factory: AgentFactory,
    options: RunnerOptions = {},
  ) {
    this.concurrency = Math.max(1, Math.min(options.concurrency ?? SECURITY_LIMITS.maxConcurrentJobs, 32));
    this.onEvent = options.onEvent;
    this.toolInvoker = options.toolInvoker;
    this.skillProvider = options.skillProvider;
  }

  private emit(event: AgentEvent): void {
    try {
      this.onEvent?.(event);
    } catch {
      // listener failures must never break the lifecycle
    }
  }

  /** Persist a state change on both the instance and its registry row. */
  private async persistState(agent: Agent, next: AgentState, taskId?: string): Promise<void> {
    agent.transitionTo(next);
    this.registry.update(agent.id, { state: next });
    this.emit({ kind: "state", agentId: agent.id, state: next, taskId });
    log("info", "agent state", { agentId: agent.id, state: next, taskId });
  }

  /**
   * Register a new agent and optionally enqueue its bootstrap task.
   *
   * When `spec.parentId` is set the new agent becomes a subagent: it inherits
   * the parent's project/session scope, receives permissions clamped to the
   * parent's envelope via {@link restrictPermissions}, and is subject to the
   * parent's `maxSubagents` budget and the global depth limit.
   *
   * @throws when the parent is missing or terminal, the subagent budget or
   *         depth limit would be exceeded, or the spec itself is invalid.
   */
  spawn(spec: AgentSpawnSpec, options: SpawnOptions = {}): SpawnResult {
    let effective: AgentSpawnSpec = { ...spec };
    if (spec.parentId !== undefined) {
      const parent = this.requireAgent(spec.parentId);
      if (["completed", "failed", "cancelled"].includes(parent.state)) {
        throw new Error(`cannot spawn a subagent under a ${parent.state} agent`);
      }
      const childCount = this.registry.listChildren(parent.id).length;
      const budget = parent.permissions.maxSubagents ?? DEFAULT_MAX_SUBAGENTS;
      if (childCount >= budget) {
        throw new Error(`parent agent ${parent.id} reached its subagent budget (${budget})`);
      }
      if (agentDepth(this.registry, parent.id) + 1 > MAX_SUBAGENT_DEPTH) {
        throw new Error(`subagent depth limit (${MAX_SUBAGENT_DEPTH}) exceeded`);
      }
      effective = {
        ...effective,
        // Children execute inside the parent's scope unless explicitly moved.
        projectId: effective.projectId ?? parent.projectId,
        sessionId: effective.sessionId ?? parent.sessionId,
        permissions: restrictPermissions(parent.permissions, effective.permissions),
      };
    }
    // Phase E: record applicable skills in the persisted context (metadata
    // only; full bodies are composed into the instance system prompt).
    let resolvedSkills: readonly Skill[] = [];
    if (this.skillProvider && effective.context?.skills === undefined) {
      try {
        resolvedSkills = this.skillProvider().filter((skill) => skillAppliesTo(skill, effective.type));
        if (resolvedSkills.length > 0) {
          effective = {
            ...effective,
            context: { ...(effective.context ?? {}), skills: resolvedSkills.map((s) => ({ name: s.name, version: s.version ?? null })) },
          };
        }
      } catch (error) {
        log("warn", "skill resolution failed", { type: effective.type, error: String(error) });
      }
    }
    const agent = this.registry.register(effective);
    if (resolvedSkills.length > 0) this.spawnedSkills.set(agent.id, resolvedSkills);
    this.emit({ kind: "spawned", agentId: agent.id, state: agent.state });
    log("info", "agent spawned", {
      agentId: agent.id,
      type: agent.type,
      parentId: agent.parentId ?? null,
      projectId: agent.projectId ?? null,
      sessionId: agent.sessionId ?? null,
    });
    if (options.task !== undefined) {
      const task = this.queue.enqueue({
        agentId: agent.id,
        type: "run",
        payload: options.task,
        ...(options.priority !== undefined ? { priority: options.priority } : {}),
      });
      this.emit({ kind: "start_requested", agentId: agent.id, taskId: task.id });
      void this.tick();
      return { agent, task };
    }
    return { agent };
  }

  /**
   * Queue an agent's bootstrap task so the next tick picks it up.
   * @returns the enqueued task record.
   * @throws when the agent does not exist or already finished.
   */
  start(agentId: string): TaskRecord {
    const descriptor = this.requireAgent(agentId);
    if (descriptor.state === "completed" || descriptor.state === "failed" || descriptor.state === "cancelled") {
      throw new Error(`agent ${agentId} is ${descriptor.state} and cannot be started`);
    }
    if (descriptor.state === "planning" || descriptor.state === "running") {
      throw new Error(`agent ${agentId} is already ${descriptor.state}`);
    }
    const existing = this.queue.list({ agentId }).filter((t) => t.status === "queued" || t.status === "running");
    if (existing.length > 0) return existing[0]!;
    const task = this.queue.enqueue({ agentId, type: "run", priority: 5 });
    this.registry.update(agentId, {});
    this.emit({ kind: "start_requested", agentId, taskId: task.id });
    log("info", "agent start requested", { agentId, taskId: task.id });
    void this.tick();
    return task;
  }

  /**
   * Cooperatively pause an agent. If it is mid-execution the pause takes
   * effect at the next await/checkpoint inside `doExecute`.
   * @throws when the agent's current state cannot be paused.
   */
  pause(agentId: string): void {
    const entry = this.live.get(agentId);
    if (entry) {
      entry.agent.pause();
      this.registry.update(agentId, { state: "paused" });
    } else {
      const descriptor = this.requireAgent(agentId);
      if (!["created", "planning", "running", "waiting_approval"].includes(descriptor.state)) {
        throw new Error(`cannot pause agent in state ${descriptor.state}`);
      }
      // Fresh instance only to reuse the transition guard; never executed.
      this.factory(descriptor).pause();
      this.registry.update(agentId, { state: "paused" });
    }
    this.emit({ kind: "paused", agentId, state: "paused" });
    log("info", "agent paused", { agentId });
  }

  /** Resume a paused agent (and its live instance) and look for runnable work. */
  resume(agentId: string): void {
    this.requireAgent(agentId);
    const entry = this.live.get(agentId);
    if (entry) entry.agent.resume(); // paused -> running on the instance too
    this.registry.update(agentId, { state: "running" });
    this.emit({ kind: "resumed", agentId, state: "running" });
    log("info", "agent resumed", { agentId });
    void this.tick();
  }

  /**
   * Cancel an agent and its entire subagent subtree: aborts in-flight work
   * via each agent's signal, cancels all non-terminal tasks, and marks every
   * record cancelled. Idempotent; cancellation only flows downward.
   */
  cancel(agentId: string): void {
    const targets = [agentId, ...this.collectDescendants(agentId)];
    for (const id of targets) this.cancelOne(id);
    log("info", "agent tree cancelled", { rootAgentId: agentId, agents: targets.length });
  }

  /** Cancel a single agent without touching its subtree. */
  private cancelOne(agentId: string): void {
    const descriptor = this.requireAgent(agentId);
    if (!["completed", "failed", "cancelled"].includes(descriptor.state)) {
      this.registry.update(agentId, { state: "cancelled" });
    }
    const entry = this.live.get(agentId);
    if (entry) entry.agent.cancel();
    const cancelledTasks = this.queue.cancelByAgent(agentId);
    this.emit({ kind: "cancelled", agentId, state: "cancelled", detail: `${cancelledTasks} task(s) cancelled` });
    log("info", "agent cancelled", { agentId, cancelledTasks });
  }

  /** All descendant ids of an agent (children, grandchildren, ...), breadth-first. */
  collectDescendants(rootId: string): string[] {
    const out: string[] = [];
    const frontier = [rootId];
    const seen = new Set<string>([rootId]);
    while (frontier.length > 0) {
      const current = frontier.shift()!;
      for (const child of this.registry.listChildren(current)) {
        if (seen.has(child.id)) continue;
        seen.add(child.id);
        out.push(child.id);
        frontier.push(child.id);
      }
    }
    return out;
  }

  /** Full status snapshot: descriptor plus current/recent tasks and children. */
  status(agentId: string): AgentStatusSnapshot {
    const agent = this.requireAgent(agentId);
    const tasks = this.queue.list({ agentId });
    const currentTask = tasks.find((t) => t.status === "running");
    const snapshot: AgentStatusSnapshot = {
      agent,
      recentTasks: tasks.slice(0, 20),
      children: this.registry.listChildren(agentId).map((child) => child.id),
    };
    if (currentTask) snapshot.currentTask = currentTask;
    return snapshot;
  }

  /**
   * Claim and launch up to `concurrency` runnable tasks. Safe to call
   * concurrently; re-entrant calls collapse into the running sweep.
   */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      for (;;) {
        if (this.live.size >= this.concurrency) return;
        // Never claim work for agents already executing or paused; claiming
        // without launching would strand the task in `running` state.
        const exclude = [...new Set([...this.live.keys(), ...this.pausedAgentIds()])];
        const task = this.queue.dequeue(exclude);
        if (!task) return;
        const descriptor = this.registry.get(task.agentId);
        if (!descriptor) {
          this.queue.failTask(task.id, new Error(`agent ${task.agentId} vanished from registry`));
          continue;
        }
        // Unreachable in practice (paused agents are excluded from dequeue),
        // but if it ever fires, give the task back instead of stranding it.
        if (descriptor.state === "paused") {
          this.queue.requeue(task.id);
          continue;
        }
        if (["cancelled", "completed", "failed"].includes(descriptor.state)) {
          // Stale task for a finished agent: drop it permanently.
          this.queue.failTask(task.id, new Error(`agent ${task.agentId} is ${descriptor.state}`));
          continue;
        }
        this.launch(descriptor, task);
      }
    } finally {
      this.ticking = false;
      this.pumpIdle();
    }
  }

  /** Ids of agents persisted as paused; their queued work must not be claimed. */
  private pausedAgentIds(): string[] {
    return this.registry.list({ state: "paused" }).map((agent) => agent.id);
  }

  /** Launch execution of a claimed task for the given descriptor. */
  private launch(descriptor: AgentDescriptor, task: TaskRecord): void {
    let agent: Agent;
    try {
      agent = this.factory(descriptor);
    } catch (error) {
      // Factory failures are deterministic configuration errors (unknown
      // type); retrying would burn the budget on an impossible launch.
      this.queue.failTask(task.id, error);
      log("error", "agent launch failed", { taskId: task.id, error: String(error) });
      return;
    }
    if (this.toolInvoker) {
      const invoker = this.toolInvoker;
      agent.attachToolInvoker((toolName, params) =>
        invoker(
          { agentId: agent.id, permissions: descriptor.permissions, taskId: task.id, signal: agent.signal },
          toolName,
          params,
        ),
      );
    }
    const skills = this.spawnedSkills.get(agent.id);
    if (skills && skills.length > 0) {
      agent.attachSystemPrompt(buildSystemPrompt(`You are agent "${descriptor.name}" of type "${descriptor.type}".`, skills), skills.map((s) => s.name));
      this.spawnedSkills.delete(agent.id);
    }
    const promise = this.runTask(agent, task);
    this.live.set(agent.id, { agent, task, promise });
    void promise.finally(() => {
      this.live.delete(agent.id);
      this.pumpIdle();
      void this.tick();
    });
  }

  /** Execute one claimed task end-to-end, mirroring every state change. */
  private async runTask(agent: Agent, task: TaskRecord): Promise<void> {
    this.pendingOperations += 1;
    try {
      try {
        await this.persistState(agent, "planning", task.id);
        const plan = await agent.plan({
          id: task.id,
          type: task.type,
          payload: task.payload,
        });
        if (agent.signal.aborted) throw new Error("cancelled before execution");
        await this.persistState(agent, "running", task.id);
        log("info", "agent plan", { agentId: agent.id, taskId: task.id, summary: plan.summary });
        const result = await agent.execute({ id: task.id, type: task.type, payload: task.payload });
        // agent.execute() already moved the instance to `completed`;
        // re-asserting is an idempotent no-op that mirrors persistence.
        this.registry.update(agent.id, { state: "completed" });
        this.queue.ack(task.id, result);
        this.emit({ kind: "state", agentId: agent.id, taskId: task.id, state: "completed" });
        this.emit({ kind: "task_completed", agentId: agent.id, taskId: task.id, state: "completed", result });
        log("info", "agent task completed", { agentId: agent.id, taskId: task.id });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        try {
          await agent.rollback();
        } catch (rollbackError) {
          log("warn", "agent rollback failed", { agentId: agent.id, error: String(rollbackError) });
        }
        if (agent.signal.aborted) {
          // Cancelled mid-flight: never re-queue, never mark failed.
          this.queue.failTask(task.id, new Error(`task cancelled: ${message}`));
          this.emit({ kind: "cancelled", agentId: agent.id, taskId: task.id, state: "cancelled" });
          log("info", "agent task cancelled", { agentId: agent.id, taskId: task.id });
          return;
        }
        const retried = this.queue.nack(task.id, error);
        const exhausted = !retried || retried.status === "failed";
        if (exhausted) {
          // The hook layer may have already moved the instance to `failed`;
          // re-asserting is idempotent. Persistence must always be mirrored.
          if (!agent.isTerminal) agent.transitionTo("failed");
          this.registry.update(agent.id, { state: "failed" });
          this.emit({ kind: "task_failed", agentId: agent.id, taskId: task.id, state: "failed", detail: message });
        }
        log(exhausted ? "error" : "warn", "agent task attempt failed", {
          agentId: agent.id,
          taskId: task.id,
          willRetry: Boolean(retried && retried.status === "queued"),
          error: message,
        });
      }
    } finally {
      this.pendingOperations -= 1;
      this.pumpIdle();
    }
  }

  /** True while a task executes or runnable work remains (incl. retry backlog). */
  get busy(): boolean {
    return this.live.size > 0 || this.pendingOperations > 0 || this.ticking || this.runnableQueued() > 0;
  }

  /** Queued task count excluding tasks parked behind paused agents. */
  private runnableQueued(): number {
    const paused = new Set(this.pausedAgentIds());
    return this.queue.list({ status: "queued" }).filter((task) => !paused.has(task.agentId)).length;
  }

  /** Resolves once no task is executing and none can start without external input. */
  waitIdle(): Promise<void> {
    if (!this.busy && !this.ticking) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  private pumpIdle(): void {
    if (this.busy || this.ticking) return;
    while (this.idleWaiters.length > 0) this.idleWaiters.pop()?.();
  }

  private requireAgent(agentId: string): AgentDescriptor {
    if (typeof agentId !== "string" || !agentId.trim()) throw new Error("agent id is required");
    const descriptor = this.registry.get(agentId);
    if (!descriptor) throw new Error(`agent ${agentId} does not exist`);
    return descriptor;
  }
}
