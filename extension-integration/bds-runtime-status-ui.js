export function createBdsRuntimeStatusUI({ root, client }) {
  const panel = document.createElement("div");
  panel.dataset.bdsRuntimeStatus = "true";
  panel.style.cssText = "font:12px system-ui,sans-serif;padding:8px;border:1px solid #888;border-radius:8px;background:#fff;color:#111;max-width:520px;white-space:pre-wrap;";
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

  const addWebCard = (result) => {
    if (!result || typeof result !== "object") return;
    const card = document.createElement("section");
    card.dataset.bdsWebAgentResult = "true";
    card.style.cssText = "margin-top:8px;padding:10px;border:1px solid #aaa;border-radius:10px;background:#fafafa;color:#111;max-width:680px;white-space:pre-wrap;";

    const heading = document.createElement("strong");
    heading.textContent = `Web Agent — ${result.pages_visited ?? 0} pages`;
    card.appendChild(heading);

    const answer = document.createElement("div");
    answer.style.marginTop = "8px";
    answer.textContent = String(result.answer ?? "No answer returned.");
    card.appendChild(answer);

    const citations = Array.isArray(result.citations) ? result.citations : [];
    if (citations.length) {
      const listHeading = document.createElement("div");
      listHeading.style.cssText = "margin-top:10px;font-weight:600;";
      listHeading.textContent = "Sources";
      card.appendChild(listHeading);
      const list = document.createElement("ol");
      list.style.margin = "6px 0 0 18px";
      for (const citation of citations) {
        const item = document.createElement("li");
        const link = document.createElement("a");
        link.href = String(citation.source_url ?? "");
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent = String(citation.source_title || citation.source_url || "source");
        item.appendChild(link);
        list.appendChild(item);
      }
      card.appendChild(list);
    }
    root.appendChild(card);
  };

  const unsubscribe = client.onEvent((event) => {
    if (event?.type === "runtime/status") render(event.payload);
    if (event?.type === "code/result") renderResult(event.payload);
    if (event?.type === "web/event" && event.payload?.type === "page_visited") {
      panel.textContent = `Web Agent: ${event.payload.payload?.pages_done ?? 0}/${event.payload.payload?.pages_total ?? "?"} pages`;
      panel.dataset.status = "researching";
    }
    if (event?.type === "web/event" && event.payload?.type === "completed") {
      panel.textContent = "Web Agent: complete";
      panel.dataset.status = "complete";
      addWebCard(event.payload.payload);
    }
    if (event?.type === "runtime/error") render({ status: `error: ${event?.payload?.message || "unknown"}` });
  });

  client.status().then((state) => {
    render({ status: state?.ok ? (state.status || "ready") : (state.status || "offline") });
  });

  return () => {
    unsubscribe();
    panel.remove();
    root.querySelectorAll('[data-bdsWebAgentResult="true"]').forEach((node) => node.remove());
  };
}
