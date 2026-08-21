/**
 * Agent core: identity, permission model, lifecycle state machine.
 *
 * An agent is a long-lived named worker registered in SQLite that executes
 * tasks pulled from the shared task queue. The {@link Agent} base class owns
 * the state machine and cooperative cancellation plumbing; concrete agents
 * implement {@link Agent.doPlan} and {@link Agent.doExecute}.
 */

/** Persisted lifecycle states of an agent. */
export type AgentState =
  | "created"
  | "planning"
  | "running"
  | "waiting_approval"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";

/** All valid agent states. */
export const AGENT_STATES: readonly AgentState[] = Object.freeze([
  "created",
  "planning",
  "running",
  "waiting_approval",
  "paused",
  "completed",
  "failed",
  "cancelled",
]);

/**
 * Allowed state transitions. Terminal states (`completed`, `failed`,
 * `cancelled`) have no outgoing edges.
 */
const STATE_TRANSITIONS: Readonly<Record<AgentState, readonly AgentState[]>> = Object.freeze({
  created: ["planning", "running", "paused", "cancelled"],
  planning: ["running", "waiting_approval", "paused", "failed", "cancelled"],
  running: ["waiting_approval", "paused", "completed", "failed", "cancelled"],
  waiting_approval: ["running", "paused", "failed", "cancelled"],
  // Pause is cooperative: work already in flight may finish and reach a
  // terminal state even though the pause flag is set.
  paused: ["running", "completed", "failed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
});

/** Returns true when moving an agent from `from` to `to` is a legal transition. */
export function canTransition(from: AgentState, to: AgentState): boolean {
  return STATE_TRANSITIONS[from].includes(to);
}

/** Narrow an unknown value to an {@link AgentState}; throws when invalid. */
export function assertAgentState(value: unknown): asserts value is AgentState {
  if (typeof value !== "string" || !AGENT_STATES.includes(value as AgentState)) {
    throw new Error(`invalid agent state: ${String(value)}`);
  }
}

/**
 * Capability limits granted to an agent. Phase A keeps this intentionally
 * small; later phases extend it with per-tool risk levels and expiry.
 */
export interface AgentPermissions {
  /** Tool names the agent may invoke. Omit to use the runtime default set. */
  tools?: readonly string[];
  /** Maximum number of direct subagents this agent may spawn. Defaults to 0 until Phase B. */
  maxSubagents?: number;
}

/** Free-form execution context carried with the agent (project paths, goals, skills...). */
export type AgentContext = Record<string, unknown>;

/** Persisted agent record as stored by the registry. */
export interface AgentDescriptor {
  id: string;
  name: string;
  type: string;
  state: AgentState;
  parentId?: string;
  projectId?: string;
  sessionId?: string;
  permissions: AgentPermissions;
  context: AgentContext;
  createdAt: string;
  updatedAt: string;
}

/** Input accepted when spawning a new agent. */
export interface AgentSpawnSpec {
  name: string;
  type: string;
  parentId?: string;
  projectId?: string;
  sessionId?: string;
  permissions?: AgentPermissions;
  context?: AgentContext;
}

/** Minimal view of a queued task handed to plan/execute hooks. */
export interface AgentTaskView {
  id: string;
  type: string;
  payload: Record<string, unknown>;
}

/** Result contract returned by the planning hook. */
export interface AgentPlan {
  /** Human-readable summary of what the agent intends to do. */
  summary: string;
  /** Ordered step descriptions; informational in Phase A. */
  steps?: readonly string[];
}

const MAX_NAME_LENGTH = 128;
const MAX_TYPE_LENGTH = 64;

/** Validate a spawn spec; throws on invalid name/type/context shapes. */
export function assertSpawnSpec(spec: AgentSpawnSpec): void {
  if (typeof spec.name !== "string" || !spec.name.trim()) throw new Error("agent name is required");
  if (spec.name.length > MAX_NAME_LENGTH) throw new Error(`agent name exceeds ${MAX_NAME_LENGTH} characters`);
  if (typeof spec.type !== "string" || !spec.type.trim()) throw new Error("agent type is required");
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(spec.type)) throw new Error("agent type must match ^[a-z][a-z0-9_-]{0,63}$");
  if (spec.parentId !== undefined && typeof spec.parentId !== "string") throw new Error("parentId must be a string");
  if (spec.projectId !== undefined && typeof spec.projectId !== "string") throw new Error("projectId must be a string");
  if (spec.sessionId !== undefined && typeof spec.sessionId !== "string") throw new Error("sessionId must be a string");
  if (spec.permissions !== undefined && (typeof spec.permissions !== "object" || spec.permissions === null || Array.isArray(spec.permissions))) {
    throw new Error("permissions must be an object");
  }
  if (spec.context !== undefined && (typeof spec.context !== "object" || spec.context === null || Array.isArray(spec.context))) {
    throw new Error("context must be an object");
  }
}

/**
 * Base class implementing the agent lifecycle state machine.
 *
 * Concrete agents implement the `do*` hooks; the public methods enforce legal
 * transitions and expose a cooperative cancellation signal that long-running
 * work should poll between steps.
 */
export abstract class Agent {
  /** Unique agent id (UUID). */
  readonly id: string;
  /** Human-readable display name. */
  readonly name: string;
  /** Registered agent type key (e.g. `demo`). */
  readonly type: string;
  readonly parentId?: string;
  readonly projectId?: string;
  readonly sessionId?: string;
  readonly permissions: AgentPermissions;
  context: AgentContext;

  private currentState: AgentState;
  private readonly abortController = new AbortController();
  private toolInvoker?: ToolInvoker;

  constructor(descriptor: AgentDescriptor) {
    this.id = descriptor.id;
    this.name = descriptor.name;
    this.type = descriptor.type;
    this.parentId = descriptor.parentId;
    this.projectId = descriptor.projectId;
    this.sessionId = descriptor.sessionId;
    this.permissions = descriptor.permissions;
    this.context = descriptor.context;
    // Instance lifecycle is execution-scoped: every constructed instance
    // starts its own machine at `created` regardless of the persisted
    // descriptor state (which may be `paused`, `running`, ...). The runner
    // mirrors progress into the registry.
    this.currentState = "created";
  }

  /** Current lifecycle state. */
  get state(): AgentState {
    return this.currentState;
  }

  /** Cancellation signal; aborted by {@link cancel}. */
  get signal(): AbortSignal {
    return this.abortController.signal;
  }

  /** Attach the runtime tool pipeline. Called by the runner at launch. */
  attachToolInvoker(invoker: ToolInvoker): void {
    this.toolInvoker = invoker;
  }

  /**
   * Invoke a registered tool through the permission/approval pipeline.
   * @throws when no pipeline is attached (agent executed outside the runner)
   *         or when the invocation is denied.
   */
  protected async callTool(toolName: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (!this.toolInvoker) throw new Error(`no tool pipeline attached to agent ${this.id}`);
    return this.toolInvoker(toolName, params);
  }

  /**
   * Move the agent to another lifecycle state.
   * Re-asserting the current state is a no-op so callers (runner) and the
   * internal hooks can both drive transitions safely.
   * @throws when the transition is not allowed by the state machine.
   */
  transitionTo(next: AgentState): void {
    assertAgentState(next);
    if (next === this.currentState) return;
    if (!canTransition(this.currentState, next)) {
      throw new Error(`illegal agent state transition ${this.currentState} -> ${next}`);
    }
    this.currentState = next;
  }

  /** True once the agent reached a terminal state. */
  get isTerminal(): boolean {
    return STATE_TRANSITIONS[this.currentState].length === 0;
  }

  /** Plan the work for a task. Moves the agent into `planning`. */
  async plan(task: AgentTaskView): Promise<AgentPlan> {
    this.transitionTo("planning");
    try {
      return await this.doPlan(task);
    } catch (error) {
      this.transitionTo("failed");
      throw error;
    }
  }

  /** Execute a planned task. Moves the agent into `running`, then `completed` on success. */
  async execute(task: AgentTaskView): Promise<unknown> {
    this.transitionTo("running");
    try {
      const result = await this.doExecute(task);
      this.validate(result);
      this.transitionTo("completed");
      return result;
    } catch (error) {
      if (!this.isTerminal) this.transitionTo("failed");
      throw error;
    }
  }

  /** Validate an execution result before completion; override to add checks. */
  validate(_result: unknown): void {}

  /** Undo partial side effects after a failure; override as needed. */
  async rollback(): Promise<void> {}

  /** Cooperatively pause: only legal between awaited steps. */
  pause(): void {
    this.transitionTo("paused");
  }

  /** Resume a paused agent. */
  resume(): void {
    this.transitionTo("running");
  }

  /** Cancel the agent and abort any in-flight work. Idempotent for terminal states. */
  cancel(): void {
    if (!this.isTerminal) this.transitionTo("cancelled");
    this.abortController.abort();
  }

  /** Planning hook implemented by concrete agents. */
  protected abstract doPlan(task: AgentTaskView): Promise<AgentPlan>;

  /** Execution hook implemented by concrete agents. */
  protected abstract doExecute(task: AgentTaskView): Promise<unknown>;
}

/** Throw when the cooperative cancellation signal has fired. */
export function assertNotAborted(agent: Agent): void {
  if (agent.signal.aborted) throw new Error(`agent ${agent.id} was cancelled`);
}

/** Async bridge to the runtime tool pipeline (injected by the runner). */
export type ToolInvoker = (toolName: string, params: Record<string, unknown>) => Promise<unknown>;
