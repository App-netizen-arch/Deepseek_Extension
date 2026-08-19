import { captureSelectedEquation } from "./bds-mathbridge.js";

const BDS_TAG = /BDS:([A-Z][A-Z0-9_]*)/g;

export function detectBdsTags(text) {
  if (typeof text !== "string") return [];
  const tags = [];
  let match;
  while ((match = BDS_TAG.exec(text))) tags.push({ name: match[1], offset: match.index });
  BDS_TAG.lastIndex = 0;
  return tags;
}

export async function publishAssistantText(text, runtimeClient) {
  const tags = detectBdsTags(text);
  if (!tags.length) return { handled: false, tags: [] };
  const mathTag = tags.find((tag) => tag.name === "MATH_ANALYZE");
  if (mathTag) {
    const selection = await captureSelectedEquation();
    if (!selection) throw new Error("BDS:MATH_ANALYZE requested, but no equation selection is available");
    await runtimeClient.request({ type: "math/analyze", payload: selection });
  }
  const otherTags = tags.filter((tag) => tag.name !== "MATH_ANALYZE");
  if (otherTags.length) await runtimeClient.request({ type: "tags", payload: { tags: otherTags, text } });
  return { handled: true, tags };
}
