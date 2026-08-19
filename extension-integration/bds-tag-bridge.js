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
  await runtimeClient.request({ type: "tags", payload: { tags, text } });
  return { handled: true, tags };
}
