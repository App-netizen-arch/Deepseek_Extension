export function createBdsRuntimeStatusUI({ root, client }) {
  const panel = document.createElement("div");
  panel.dataset.bdsRuntimeStatus = "true";
  panel.style.cssText = "font:12px system-ui,sans-serif;padding:8px;border:1px solid #888;border-radius:8px;background:#fff;color:#111;max-width:320px;";
  panel.textContent = "Better DeepSeek runtime: checking…";
  root.appendChild(panel);

  const render = (state) => {
    const status = state?.status || "offline";
    panel.textContent = `Better DeepSeek runtime: ${status}`;
    panel.dataset.status = status;
  };

  const unsubscribe = client.onEvent((event) => {
    if (event?.type === "runtime/status") render(event.payload);
  });

  client.status().then((state) => {
    render({ status: state?.ok ? (state.status || "ready") : (state.status || "offline") });
  });

  return () => {
    unsubscribe();
    panel.remove();
  };
}
