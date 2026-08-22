<script>
  import { t } from "../../lib/i18n.svelte.js";

  let approvals = $state([]);
  let visible = $state(false);
  let busyId = $state(null);
  let pollTimer = null;

  const POLL_MS = 5000;

  async function refresh() {
    try {
      const res = await chrome.runtime.sendMessage({ type: "BDS_RUNTIME_APPROVALS_LIST" });
      if (res && res.ok && Array.isArray(res.approvals)) {
        approvals = res.approvals;
        visible = approvals.length > 0;
      } else {
        // Unreachable / unconfigured runtime: stay silent.
        approvals = [];
        visible = false;
      }
    } catch {
      approvals = [];
      visible = false;
    }
  }

  async function decide(id, decision) {
    busyId = id;
    try {
      await chrome.runtime.sendMessage({ type: "BDS_RUNTIME_APPROVAL_DECIDE", id, decision });
    } finally {
      busyId = null;
      approvals = approvals.filter((a) => a.id !== id);
      if (approvals.length === 0) visible = false;
      refresh();
    }
  }

  function secondsLeft(expiresAt) {
    const ms = Date.parse(String(expiresAt || "")) - Date.now();
    return Number.isFinite(ms) && ms > 0 ? Math.ceil(ms / 1000) : 0;
  }

  function describeApproval(approval) {
    const action = String(approval.action || "");
    return action.startsWith("tool:") ? action.slice(5) : action;
  }

  $effect(() => {
    refresh();
    pollTimer = setInterval(refresh, POLL_MS);
    return () => {
      if (pollTimer) clearInterval(pollTimer);
    };
  });
</script>

{#if visible}
  <div class="bds-approvals-stack" role="region" aria-label={t("runtimeApprovals.region")}>
    {#each approvals as approval (approval.id)}
      <div class="bds-approval-card">
        <div class="bds-approval-head">
          <span class="bds-approval-title">{t("runtimeApprovals.title")}</span>
          <span class="bds-approval-ttl">{secondsLeft(approval.expires_at)}s</span>
        </div>
        <div class="bds-approval-body">
          <div class="bds-approval-tool">{describeApproval(approval)}</div>
          <code class="bds-approval-target">{String(approval.target || '')}</code>
          <div class="bds-approval-agent">{t("runtimeApprovals.agent")}: {String(approval.task_id || approval.agent_id || '—')}</div>
        </div>
        <div class="bds-approval-actions">
          <button
            class="bds-approval-btn bds-approve"
            disabled={busyId === approval.id}
            onclick={() => decide(approval.id, 'approved')}
          >{t("runtimeApprovals.approve")}</button>
          <button
            class="bds-approval-btn bds-deny"
            disabled={busyId === approval.id}
            onclick={() => decide(approval.id, 'denied')}
          >{t("runtimeApprovals.deny")}</button>
        </div>
      </div>
    {/each}
  </div>
{/if}

<style>
  .bds-approvals-stack {
    position: fixed;
    right: 24px;
    bottom: 96px;
    z-index: 2147483000;
    display: flex;
    flex-direction: column;
    gap: 8px;
    max-width: 340px;
    font-family: inherit;
  }
  .bds-approval-card {
    background: var(--ds-bg-elevated, #ffffff);
    color: var(--ds-text-primary, #1a1a1a);
    border: 1px solid var(--ds-border, #e5e5e5);
    border-radius: 12px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.14);
    padding: 10px 12px;
  }
  .bds-approval-head {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    margin-bottom: 6px;
  }
  .bds-approval-title {
    font-size: 12px;
    font-weight: 600;
  }
  .bds-approval-ttl {
    font-size: 11px;
    opacity: 0.65;
    font-variant-numeric: tabular-nums;
  }
  .bds-approval-body {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-bottom: 8px;
  }
  .bds-approval-tool {
    font-size: 13px;
    font-weight: 600;
  }
  .bds-approval-target {
    font-size: 11px;
    background: var(--ds-bg-subtle, #f5f5f5);
    border-radius: 6px;
    padding: 4px 6px;
    word-break: break-all;
    max-height: 64px;
    overflow: auto;
  }
  .bds-approval-agent {
    font-size: 11px;
    opacity: 0.7;
  }
  .bds-approval-actions {
    display: flex;
    gap: 8px;
  }
  .bds-approval-btn {
    flex: 1;
    border: none;
    border-radius: 8px;
    padding: 6px 10px;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
  }
  .bds-approval-btn:disabled {
    opacity: 0.55;
    cursor: default;
  }
  .bds-approve {
    background: #4d6bfe;
    color: #fff;
  }
  .bds-deny {
    background: var(--ds-bg-subtle, #f0f0f0);
    color: inherit;
  }
</style>
