export function createBdsRuntimeStatusUI({ root, client }) {
  const panel = document.createElement("div");
  panel.dataset.bdsRuntimeStatus = "true";
  panel.style.cssText = "font:12px system-ui,sans-serif;padding:8px;border:1px solid #888;border-radius:8px;background:#fff;color:#111;max-width:420px;white-space:pre-wrap;";
  panel.textContent = "Better DeepSeek runtime: checking…";
  root.appendChild(panel);

  const render = (state) => {
    const status = state?.status || "offline";
    panel.textContent = `Better DeepSeek runtime: ${status}`;
    panel.dataset.status = status;
  };

  const renderResult = (result) => {
    const title = `LOCAL_EXEC ${result?.language || "unknown"} · ${result?.timed_out ? "timeout" : `exit ${result?.exit_code ?? "?"}`}`;
    const output = [
      result?.stdout ? `stdout:\n${result.stdout}` : "stdout: (empty)",
      result?.stderr ? `stderr:\n${result.stderr}` : "stderr: (empty)",
    ].join("\n\n");
    panel.textContent = `${title}\n${output}${result?.truncated ? "\n\n[output truncated]" : ""}`;
    panel.dataset.status = result?.timed_out ? "timeout" : "complete";
  };

  const unsubscribe = client.onEvent((event) => {
    if (event?.type === "runtime/status") render(event.payload);
    if (event?.type === "code/result") renderResult(event.payload);
    if (event?.type === "runtime/error") render({ status: `error: ${event?.payload?.message || "unknown"}` });
  });

  client.status().then((state) => {
    render({ status: state?.ok ? (state.status || "ready") : (state.status || "offline") });
  });

  return () => {
    unsubscribe();
    panel.remove();
  };
}
