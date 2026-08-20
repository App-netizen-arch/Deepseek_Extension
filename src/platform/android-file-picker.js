/**
 * Deprecated compatibility path.
 *
 * Android support was removed. This module only forwards the legacy import to
 * the browser-neutral file-picker adapter so existing extension source stays
 * compatible until its import can be renamed in a dedicated cleanup change.
 */
export {
  PICK_ERRORS,
  isNativeFilePickerAvailable,
  nativePickFiles,
  pickedEntryToFile,
  buildFolderFileFromNative,
  openNativeFilePicker,
} from "./native-file-picker.js";
