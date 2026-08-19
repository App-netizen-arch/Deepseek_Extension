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
  const payload = { tags, text };
  if (tags.some(tag => tag.name === "CODE_AGENT")) await runtimeClient.requestCode({ type: "code/task", payload: parseCodeAgentTask(text) });
  const nonCodeTags = tags.filter(tag => tag.name !== "CODE_AGENT");
  if (nonCodeTags.length) await runtimeClient.request({ type: "tags", payload });
  return { handled: true, tags };
}

function parseCodeAgentTask(text) {
  const block = text.slice(text.indexOf("BDS:CODE_AGENT"));
  const task = block.match(/(?:^|\n)\s*task\s*=\s*["']([\s\S]*?)["']\s*(?:\n|$)/i)?.[1]?.trim();
  const workspace = block.match(/(?:^|\n)\s*workspace\s*=\s*["']([^"']+)["']/i)?.[1]?.trim();
  const maxIterations = Number(block.match(/(?:^|\n)\s*max_iterations\s*=\s*(\d+)/i)?.[1] ?? 30);
  const approval = block.match(/(?:^|\n)\s*approval\s*=\s*["']([^"']+)["']/i)?.[1];
  if (!task) throw new Error("BDS:CODE_AGENT task is required");
  return { task, ...(workspace ? { workspace } : {}), max_iterations: Math.max(1, Math.min(30, maxIterations)), ...(approval ? { approval: approval === "always" ? "always" : "auto_for_known" } : {}) };
}
