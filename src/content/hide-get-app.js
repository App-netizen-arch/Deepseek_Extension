function hideMatchingGetAppButtons() {
  const candidates = document.querySelectorAll("button, .ds-button");
  for (const button of candidates) {
    const text = button.textContent?.trim() ?? "";
    if (text !== "Get App") continue;
    button.setAttribute("data-bds-hide", "true");
  }
}

export function hideGetAppButton() {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  if (window.__bdsGetAppObserver) return;

  hideMatchingGetAppButtons();
  const observer = new MutationObserver(() => hideMatchingGetAppButtons());
  observer.observe(document.documentElement || document.body, {
    childList: true,
    subtree: true,
  });
  window.__bdsGetAppObserver = observer;
}
