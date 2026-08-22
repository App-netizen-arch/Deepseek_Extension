<script>
  import { t } from "../../lib/i18n.svelte.js";

  let agents = $state([]);
  let visible = $state(false);
  let expanded = $state(false);
  let pollTimer = null;

  const POLL_MS = 5000;
  /** States worth surfacing; finished agents are hidden. */
  const ACTIVE_STATES = new Set(["created", "planning", "running", "waiting_approval", "paused"]);

  async function refresh() {
    try {
      const res = await chrome.runtime.sendMessage({ type: "BDS_RUNTIME_AGENTS_LIST" });
      if (res && res.ok && Array.isArray(res.agents)) {
        agents = res.agents.filter((a) => ACTIVE_STATES.has(String(a.state)));
        visible = agents.length > 0;
      } else {
        agents = [];
        visible = false;
      }
    } catch {
      agents = [];
      visible = false;
    }
  }

  function stateClass(state) {
    return `bds-agent-state-${String(state || 'unknown').replace(/[^a-z_]/g, '')}`;
  }

  function agentLabel(agent) {
    const name = String(agent.name || '').slice(0, 24);
    return name.length < String(agent.name || '').length ? `${name}…` : name;
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
  <div class="bds-agents-panel">
    <button class="bds-agents-toggle" onclick={() => (expanded = !expanded)} aria-expanded={expanded}>
      <span class="bds-agents-dot" aria-hidden="true"></span>
      {t("agentStatus.title")} · {agents.length}
    </button>
    {#if expanded}
      <ul class="bds-agents-list">
        {#each agents as agent (agent.id)}
          <li class="bds-agent-row">
            <span class="bds-agent-name">{agentLabel(agent)}</span>
            <span class="bds-agent-badge {stateClass(agent.state)}">{String(agent.state)}</span>
          </li>
        {/each}
      </ul>
    {/if}
  </div>
{/if}

<style>
  .bds-agents-panel {
    position: fixed;
    left: 24px;
    bottom: 96px;
    z-index: 2147483000;
    font-family: inherit;
  }
  .bds-agents-toggle {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    border: 1px solid var(--ds-border, #e5e5e5);
    background: var(--ds-bg-elevated, #ffffff);
    color: var(--ds-text-primary, #1a1a1a);
    border-radius: 999px;
    box-shadow: 0 6px 18px rgba(0, 0, 0, 0.12);
    font-size: 12px;
    font-weight: 600;
    padding: 6px 12px;
    cursor: pointer;
  }
  .bds-agents-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #4d6bfe;
    animation: bds-agent-pulse 1.6s ease-in-out infinite;
  }
  @keyframes bds-agent-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.35; }
  }
  .bds-agents-list {
    list-style: none;
    margin: 8px 0 0;
    padding: 8px;
    max-height: 220px;
    overflow: auto;
    min-width: 200px;
    background: var(--ds-bg-elevated, #ffffff);
    color: var(--ds-text-primary, #1a1a1a);
    border: 1px solid var(--ds-border, #e5e5e5);
    border-radius: 12px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.14);
  }
  .bds-agent-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 10px;
    padding: 4px 2px;
    font-size: 12px;
  }
  .bds-agent-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .bds-agent-badge {
    font-size: 10px;
    padding: 2px 8px;
    border-radius: 999px;
    background: var(--ds-bg-subtle, #f0f0f0);
    white-space: nowrap;
  }
  .bds-agent-state-running { background: #4d6bfe; color: #fff; }
  .bds-agent-state-planning { background: #f5a623; }
  .bds-agent-state-waiting_approval { background: #e74c3c; color: #fff; }
  .bds-agent-state-paused { background: #95a5a6; color: #fff; }
</style>
