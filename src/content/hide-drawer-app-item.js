export const DRAWER_APP_ITEM_TEXT = "Download mobile App";

function hideMatchingItems() {
  const labels = document.querySelectorAll(".ds-dropdown-menu .ds-dropdown-menu-option");
  for (const item of labels) {
    const label = item.querySelector(".ds-dropdown-menu-option__label");
    const text = label?.textContent?.trim() ?? "";
    if (text === DRAWER_APP_ITEM_TEXT || text.includes(DRAWER_APP_ITEM_TEXT)) {
      item.setAttribute("data-bds-hide", "true");
    }
  }
}

export function hideDrawerAppItem() {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  if (window.__bdsDrawerItemObserver) return;

  hideMatchingItems();
  const observer = new MutationObserver(() => hideMatchingItems());
  observer.observe(document.documentElement || document.body, {
    childList: true,
    subtree: true,
  });
  window.__bdsDrawerItemObserver = observer;
}
