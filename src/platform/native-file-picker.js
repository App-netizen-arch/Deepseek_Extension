/**
 * Browser-neutral native-file-picker compatibility helpers.
 *
 * The native Android implementation was intentionally removed. These helpers
 * preserve the existing AttachMenu contract for Chrome/Firefox while routing
 * normal file selection through the DOM picker already used by the extension.
 */

export const PICK_ERRORS = Object.freeze({
  UNAVAILABLE: "native-file-picker-unavailable",
  CANCELLED: "native-file-picker-cancelled",
  INVALID: "native-file-picker-invalid",
});

export function isNativeFilePickerAvailable() {
  return false;
}

export async function nativePickFiles() {
  return [];
}

export function pickedEntryToFile(entry) {
  if (typeof File !== "undefined" && entry instanceof File) return entry;
  if (entry && typeof entry === "object" && entry.file instanceof File) return entry.file;
  return null;
}

export async function buildFolderFileFromNative() {
  throw new Error(PICK_ERRORS.UNAVAILABLE);
}

export function openNativeFilePicker(input) {
  if (!input || typeof input.click !== "function") {
    throw new Error(PICK_ERRORS.UNAVAILABLE);
  }
  input.click();
}
