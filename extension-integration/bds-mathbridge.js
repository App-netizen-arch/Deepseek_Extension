const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

function closestEquationElement(node) {
  if (!(node instanceof Element)) return null;
  return node.closest("math, .katex, mjx-container, img[alt], img[aria-label], [data-latex], [data-math]");
}

function readLatexFromElement(element) {
  const direct = element.getAttribute("data-latex") || element.getAttribute("data-math");
  if (direct) return { kind: "latex", content: direct };
  const annotation = element.querySelector?.('annotation[encoding="application/x-tex"]');
  if (annotation?.textContent?.trim()) return { kind: "latex", content: annotation.textContent.trim() };
  const tex = element.querySelector?.('semantics annotation');
  if (tex?.textContent?.trim()) return { kind: "latex", content: tex.textContent.trim() };
  if (element.matches?.("math")) return { kind: "mathml", content: element.outerHTML };
  if (element.matches?.(".katex, mjx-container")) {
    const annotationText = element.querySelector?.("annotation")?.textContent?.trim();
    if (annotationText) return { kind: "latex", content: annotationText };
  }
  return null;
}

async function imageToDataUrl(image) {
  if (!(image instanceof HTMLImageElement)) throw new Error("image element required");
  const width = image.naturalWidth || image.width;
  const height = image.naturalHeight || image.height;
  if (!width || !height) throw new Error("image has no dimensions");
  const canvas = document.createElement("canvas");
  canvas.width = Math.min(width, 4096);
  canvas.height = Math.min(height, 4096);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("canvas unavailable");
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  const dataUrl = canvas.toDataURL("image/png");
  const payloadBytes = Math.ceil((dataUrl.length * 3) / 4);
  if (payloadBytes > MAX_IMAGE_BYTES) throw new Error("equation image exceeds 8 MiB");
  return dataUrl;
}

export function captureSelectedEquation() {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
  const container = selection.getRangeAt(0).commonAncestorContainer;
  const element = closestEquationElement(container.nodeType === Node.ELEMENT_NODE ? container : container.parentElement);
  const direct = element && readLatexFromElement(element);
  if (direct) {
    return { ...direct, source: "selection", source_url: location.href, page_title: document.title };
  }
  const image = element?.matches?.("img") ? element : element?.querySelector?.("img");
  if (image) {
    return imageToDataUrl(image).then((content) => ({
      kind: "image",
      content,
      source: "selection",
      source_url: location.href,
      page_title: document.title,
    }));
  }
  return null;
}

export function createMathAnalyzeButton({ root, runtimeClient, onResult, onError }) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "Analyze equation";
  button.dataset.bdsMathAnalyze = "true";
  button.style.cssText = "position:fixed;z-index:2147483647;display:none;padding:7px 10px;border:1px solid #888;border-radius:7px;background:#fff;color:#111;font:12px system-ui,sans-serif;box-shadow:0 2px 10px rgba(0,0,0,.15);";
  (root || document.body).appendChild(button);

  let pending = null;
  let timer = null;

  const hide = () => { button.style.display = "none"; pending = null; };
  const onSelection = async () => {
    try {
      pending = await captureSelectedEquation();
      if (!pending) { hide(); return; }
      const rect = window.getSelection()?.rangeCount ? window.getSelection().getRangeAt(0).getBoundingClientRect() : null;
      button.style.left = `${Math.min(Math.max(rect?.left ?? 20, 8), window.innerWidth - 170)}px`;
      button.style.top = `${Math.min(Math.max((rect?.bottom ?? 40) + 8, 8), window.innerHeight - 50)}px`;
      button.style.display = "block";
    } catch (error) {
      hide();
      onError?.(error);
    }
  };

  document.addEventListener("mouseup", () => {
    clearTimeout(timer);
    timer = setTimeout(() => void onSelection(), 50);
  }, true);
  document.addEventListener("scroll", hide, true);

  button.addEventListener("click", async () => {
    try {
      if (!pending) return;
      button.disabled = true;
      await runtimeClient.request({ type: "math/analyze", payload: pending });
      hide();
    } catch (error) {
      onError?.(error);
    } finally {
      button.disabled = false;
    }
  });

  const unsubscribe = runtimeClient.onEvent((event) => {
    if (event?.type === "math/result") onResult?.(event.payload);
    if (event?.type === "runtime/error") onError?.(new Error(event.payload?.message || "MathBridge error"));
  });

  return () => {
    unsubscribe();
    clearTimeout(timer);
    button.remove();
  };
}
