/**
 * Tool invocation service: the single gate every tool call passes through.
 *
 * Enforcement order: registry existence -> enabled flag -> agent permission
 * list -> shared risk policy (`policyDecision`). `high` tools create an
 * expiring approval row and wait for a user decision; `critical` is denied
 * outright. Every step is audited.
 */
import { randomUUID } from "node:crypto";
import { log } from "../operational.js";
import { policyDecision } from "../security-policy.js";
import { checkPermission, type PermissionStore } from "../security/permissions.js";
import type { RuntimeStore } from "../store.js";
import type { AgentPermissions } from "../agent/agent.js";
import type { ToolRegistry } from "./registry.js";
import type { ToolContext } from "./tool.js";

/** Who is calling a tool. */
export interface ToolCaller {
  agentId: string;
  /** Permission envelope of the calling agent (undefined = default set). */
  permissions?: AgentPermissions;
  taskId?: string;
  /** Cooperative cancellation propagated into long-running tools. */
  signal?: AbortSignal;
}

/** Options for the invocation service. */
export interface ToolServiceOptions {
  /** Approval time-to-live in ms (default 5 minutes). */
  approvalTtlMs?: number;
  /** Approval polling interval in ms (default 200). */
  pollMs?: number;
  /** Permission rule store; rules override the default risk policy per agent/tool/glob. */
  permissions?: PermissionStore;
  /** Notified whenever a new pending approval is created (for WS push). */
  onApprovalRequested?: (info: { id: string; agentId: string; tool: string; target: string; expiresAt: string }) => void;
}

const DEFAULT_TTL_MS = 5 * 60_000;
const DEFAULT_POLL_MS = 200;

export class ToolInvocationService {
  private readonly approvalTtlMs: number;
  private readonly pollMs: number;
  private readonly permissions?: PermissionStore;
  private readonly onApprovalRequested?: NonNullable<ToolServiceOptions["onApprovalRequested"]>;

  constructor(
    private readonly registry: ToolRegistry,
    private readonly store: RuntimeStore,
    /** Workspace injected into every ToolContext. */
    private readonly workspace: string,
    options: ToolServiceOptions = {},
  ) {
    this.approvalTtlMs = Math.max(1000, options.approvalTtlMs ?? DEFAULT_TTL_MS);
    this.pollMs = Math.max(25, options.pollMs ?? DEFAULT_POLL_MS);
    this.permissions = options.permissions;
    this.onApprovalRequested = options.onApprovalRequested;
  }

  /**
   * Validate, authorize, and execute a tool call.
   * @returns whatever the tool's execute() resolves with.
   * @throws on unknown/disabled tools, permission denials, denied or expired
   *         approvals, and any tool execution failure.
   */
  async invoke(caller: ToolCaller, toolName: string, params: unknown): Promise<unknown> {
    const tool = this.registry.get(toolName);
    if (!tool) throw new Error(`unknown tool: ${toolName}`);
    if (!this.registry.isEnabled(toolName)) throw new Error(`tool ${toolName} is disabled`);
    const allowedTools = caller.permissions?.tools;
    if (allowedTools !== undefined && !allowedTools.includes(toolName)) {
      this.store.audit("tool.denied", { agentId: caller.agentId, tool: toolName, reason: "not in agent tool list" });
      throw new Error(`tool ${toolName} is not permitted for agent ${caller.agentId}`);
    }

    // Phase F: explicit permission rules take precedence over the default
    // risk policy. `deny` blocks, `allow` pre-consents (the only way a
    // critical tool may run), `ask` forces approval even for low/medium.
    const resource = typeof (params as Record<string, unknown> | null | undefined)?.path === "string"
      ? String((params as Record<string, unknown>).path)
      : typeof (params as Record<string, unknown> | null | undefined)?.url === "string"
        ? String((params as Record<string, unknown>).url)
        : undefined;
    const ruleDecision = this.permissions
      ? checkPermission(this.permissions.list({ agentId: caller.agentId, tool: toolName }), {
          agentId: caller.agentId,
          tool: toolName,
          ...(resource !== undefined ? { resource } : {}),
        })
      : undefined;
    if (ruleDecision === "deny") {
      this.store.audit("tool.denied", { agentId: caller.agentId, tool: toolName, reason: "permission rule" });
      throw new Error(`tool ${toolName} is denied by permission rule for agent ${caller.agentId}`);
    }

    let requiresApproval = ruleDecision ? ruleDecision === "ask" : policyDecision(tool.permissionLevel) === "ask";
    if (!ruleDecision && tool.permissionLevel === "critical" && policyDecision("critical") === "deny") {
      this.store.audit("tool.denied", { agentId: caller.agentId, tool: toolName, reason: "critical risk tier" });
      throw new Error(`tool ${toolName} is critical risk and cannot be executed`);
    }
    if (requiresApproval) {
      await this.requestApproval(caller, toolName, params);
    }

    const context: ToolContext = {
      agentId: caller.agentId,
      ...(caller.taskId !== undefined ? { taskId: caller.taskId } : {}),
      workspace: this.workspace,
      ...(caller.signal ? { signal: caller.signal } : {}),
    };
    this.store.audit("tool.start", { agentId: caller.agentId, tool: toolName, level: tool.permissionLevel });
    try {
      const result = await tool.execute(params as Record<string, unknown>, context);
      this.store.audit("tool.complete", { agentId: caller.agentId, tool: toolName });
      return result;
    } catch (error) {
      this.store.audit("tool.error", {
        agentId: caller.agentId,
        tool: toolName,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Create an approval request and block until it is decided or expires.
   * @throws when denied (`approval_denied:<id>`) or expired (`approval_expired:<id>`).
   */
  private async requestApproval(caller: ToolCaller, toolName: string, params: unknown): Promise<void> {
    const id = randomUUID();
    const expiresAt = new Date(Date.now() + this.approvalTtlMs).toISOString();
    this.store.createApproval(id, caller.taskId ?? caller.agentId, `tool:${toolName}`, JSON.stringify(params ?? {}).slice(0, 512), expiresAt);
    this.store.audit("tool.approval.requested", { approval_id: id, agentId: caller.agentId, tool: toolName });
    log("info", "tool approval requested", { approvalId: id, agentId: caller.agentId, tool: toolName });
    try {
      this.onApprovalRequested?.({ id, agentId: caller.agentId, tool: toolName, target: JSON.stringify(params ?? {}).slice(0, 512), expiresAt });
    } catch {
      // push failures must never block the approval flow
    }
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, this.pollMs));
      const row = this.store.getApproval(id) as { status: string; expires_at: string } | undefined;
      if (!row) throw new Error(`approval record vanished: ${id}`);
      if (row.status === "approved") {
        this.store.audit("tool.approval.granted", { approval_id: id, agentId: caller.agentId, tool: toolName });
        return;
      }
      if (row.status === "denied") {
        this.store.audit("tool.approval.denied", { approval_id: id, agentId: caller.agentId, tool: toolName });
        throw new Error(`approval_denied:${id}`);
      }
      if (Date.parse(row.expires_at) <= Date.now()) {
        this.store.decideApproval(id, "denied");
        this.store.audit("tool.approval.expired", { approval_id: id, agentId: caller.agentId, tool: toolName });
        throw new Error(`approval_expired:${id}`);
      }
    }
  }
}
