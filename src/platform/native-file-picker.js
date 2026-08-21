/**
 * Browser-neutral native-file-picker compatibility helpers.
 *
 * Handles Android native file picker integration with multi-chunk payload
 * reassembly, timeout management, and error handling.
 */

export const PICK_ERRORS = Object.freeze({
  UNAVAILABLE: "native-file-picker-unavailable",
  CANCELLED: "native-file-picker-cancelled",
  INVALID: "native-file-picker-invalid",
  TIMEOUT: "picker-timeout",
  STALLED: "read-stalled",
  MALFORMED: "malformed-payload",
});

/**
 * Check if the native Android file picker is available.
 * @returns {boolean}
 */
export function isNativeFilePickerAvailable() {
  return (
    typeof window !== "undefined" &&
    window.AndroidBridge &&
    typeof window.AndroidBridge.pickFiles === "function"
  );
}

/**
 * Pick files using the native Android picker.
 * Handles multi-chunk payload reassembly and timeouts.
 * @param {string} mode - "files", "folder", or specific MIME type filter
 * @returns {Promise<{files: Array, skipped: Array, folderName?: string, cancelled?: boolean}>}
 */
export async function nativePickFiles(mode) {
  if (!isNativeFilePickerAvailable()) {
    throw new Error("AndroidBridge.pickFiles not available");
  }

  return new Promise((resolve, reject) => {
    const requestId = Math.random().toString(36).substring(2);
    const chunks = new Map();
    let totalChunks = 0;
    let isReading = false;
    let launchTimer = null;
    let readStallTimer = null;
    let absoluteTimer = null;
    let returnGraceTimer = null;

    const cleanup = () => {
      if (launchTimer) clearTimeout(launchTimer);
      if (readStallTimer) clearTimeout(readStallTimer);
      if (absoluteTimer) clearTimeout(absoluteTimer);
      if (returnGraceTimer) clearTimeout(returnGraceTimer);

      window.removeEventListener(
        `__bds_native_files_picked_${requestId}`,
        handlePickEvent
      );
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        // Start return grace timer when doc becomes visible
        if (returnGraceTimer) clearTimeout(returnGraceTimer);
        returnGraceTimer = setTimeout(() => {
          cleanup();
          reject(new Error(PICK_ERRORS.TIMEOUT));
        }, 30000);
      }
    };

    const handlePickEvent = (event) => {
      const detail = event.detail;

      if (detail.v === 2 && detail.kind === "status") {
        if (detail.status === "opened") {
          // Clear launch timer, keep session alive
          if (launchTimer) clearTimeout(launchTimer);
          launchTimer = null;
        } else if (detail.status === "reading") {
          // Start read stall timer
          if (returnGraceTimer) clearTimeout(returnGraceTimer);
          isReading = true;
          if (readStallTimer) clearTimeout(readStallTimer);
          readStallTimer = setTimeout(() => {
            cleanup();
            reject(new Error(PICK_ERRORS.STALLED));
          }, 120000);
        }
      } else if (detail.v === 2 && detail.kind === "chunk") {
        // Reset timers on chunk arrival
        if (readStallTimer) clearTimeout(readStallTimer);
        if (returnGraceTimer) clearTimeout(returnGraceTimer);

        chunks.set(detail.seq, detail.data);
        totalChunks = detail.total;

        if (chunks.size === totalChunks) {
          // All chunks received
          try {
            const json = Array.from({ length: totalChunks })
              .map((_, i) => chunks.get(i))
              .join("");
            const payload = JSON.parse(json);
            cleanup();
            resolve(payload);
          } catch (e) {
            cleanup();
            reject(new Error(PICK_ERRORS.MALFORMED));
          }
        }
      } else if (!detail.v) {
        // Legacy v1 payload (single event)
        if (detail.error && detail.error !== "cancelled") {
          cleanup();
          reject(new Error(detail.error));
        } else if (detail.error === "cancelled") {
          cleanup();
          resolve({ cancelled: true, files: [], skipped: [] });
        } else {
          cleanup();
          resolve({
            files: detail.files || [],
            skipped: detail.skipped || [],
            folderName: detail.folderName,
          });
        }
      }
    };

    // Set up event listeners
    window.addEventListener(
      `__bds_native_files_picked_${requestId}`,
      handlePickEvent
    );
    document.addEventListener("visibilitychange", handleVisibilityChange);

    // Start launch timer (10 seconds to "opened" status)
    launchTimer = setTimeout(() => {
      cleanup();
      reject(new Error(PICK_ERRORS.TIMEOUT));
    }, 10000);

    // Absolute 10 minute cap
    absoluteTimer = setTimeout(() => {
      cleanup();
      reject(new Error(PICK_ERRORS.TIMEOUT));
    }, 10 * 60 * 1000);

    // Initiate native picker
    window.AndroidBridge.pickFiles(mode, requestId);
  });
}

/**
 * Convert a picked native entry to a File object.
 * Handles base64-encoded content and text content.
 * @param {Object} entry - Entry with name, content, optional encoding and mime
 * @returns {File}
 */
export function pickedEntryToFile(entry) {
  if (typeof File !== "undefined" && entry instanceof File) return entry;
  if (entry && typeof entry === "object" && entry.file instanceof File)
    return entry.file;

  if (!entry || typeof entry !== "object") return null;

  const { name, content, encoding, mime } = entry;

  if (!name || !content) return null;

  let blob;

  if (encoding === "base64") {
    // Decode base64
    const binaryString = atob(content);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    blob = new Blob([bytes], { type: mime || "application/octet-stream" });
  } else {
    // Text content
    blob = new Blob([content], { type: mime || "text/plain" });
  }

  return new File([blob], name, { type: blob.type });
}

/**
 * Build a workspace file from folder contents.
 * Concatenates markdown and text files into a single text file.
 * @param {Array<Object>} files - Array of file objects from native picker
 * @param {string} folderName - Name of the folder being shared
 * @returns {File|null}
 */
export function buildFolderFileFromNative(files, folderName) {
  if (!files || files.length === 0) return null;

  // Build directory tree
  const tree = {};
  const markdownFiles = [];

  for (const file of files) {
    const parts = file.name.split("/");
    let current = tree;

    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      if (!current[part]) current[part] = {};
      current = current[part];
    }

    current[parts[parts.length - 1]] = { isFile: true, file };

    // Collect markdown/text files
    if (
      !file.encoding &&
      (file.name.endsWith(".md") ||
        file.name.endsWith(".txt") ||
        file.name.endsWith(".js") ||
        file.name.endsWith(".json"))
    ) {
      markdownFiles.push(file);
    }
  }

  // Format tree
  let treeStr = "Directory Tree:\n";
  const renderTree = (obj, indent = "") => {
    for (const key of Object.keys(obj).sort()) {
      if (obj[key].isFile) {
        treeStr += `${indent}├── ${key}\n`;
      } else {
        treeStr += `${indent}├── ${key}/\n`;
        renderTree(obj[key], indent + "│   ");
      }
    }
  };
  renderTree(tree);

  // Build content
  let content = `# ${folderName} Workspace\n\n${treeStr}\n\n---\n\n`;

  for (const file of markdownFiles) {
    content += `--- [FILE: ${file.name}] ---\n${file.content}\n\n`;
  }

  const blob = new Blob([content], { type: "text/plain" });
  return new File([blob], `${folderName}_workspace.txt`, {
    type: "text/plain",
  });
}

/**
 * Open native file picker by clicking a hidden input element.
 * @param {HTMLInputElement} input - File input element to click
 * @throws {Error} If input is not a valid file input element
 */
export function openNativeFilePicker(input) {
  if (!input || typeof input.click !== "function") {
    throw new Error(PICK_ERRORS.UNAVAILABLE);
  }
  input.click();
}
