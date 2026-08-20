const HIDE_ATTR = "data-bds-hide";

function installHideStyle() {
  if (typeof document === "undefined") return;
  if (document.querySelector(`style[data-bds-hide-style="true"]`)) return;

  const style = document.createElement("style");
  style.dataset.bdsHideStyle = "true";
  style.textContent = `[${HIDE_ATTR}] { display: none !important; }`;
  (document.head || document.documentElement).appendChild(style);
}

function getHideTarget(label) {
  const control = label.closest?.("button, .ds-button, [role='button']");
  if (!control) return null;
  return control.matches?.(".ds-button")
    ? control
    : control.parentElement || control;
}

function hideMatchingGetAppButtons() {
  installHideStyle();

  for (const span of document.querySelectorAll("span")) {
    if (span.textContent?.trim() !== "Get App") continue;

    const target = getHideTarget(span);
    if (target && !target.hasAttribute(HIDE_ATTR)) {
      target.setAttribute(HIDE_ATTR, "");
    }
  }
}

export function hideGetAppButton() {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  if (window.__bdsGetAppObserver) return;

  hideMatchingGetAppButtons();

  let rafId = 0;
  const observer = new MutationObserver(() => {
    hideMatchingGetAppButtons();
    cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(hideMatchingGetAppButtons);
  });

  observer.observe(document.body || document.documentElement, {
    subtree: true,
    childList: true,
    characterData: true,
  });

  window.__bdsGetAppObserver = observer;
}
