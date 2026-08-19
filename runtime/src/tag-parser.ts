export interface BdsTag {
  name: string;
  attributes: Record<string, unknown>;
  raw: string;
  start: number;
  end: number;
}

const TAG_RE = /BDS:([A-Z][A-Z0-9_]*)/g;

function parseValue(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "null") return null;
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  try { return JSON.parse(trimmed); } catch { return trimmed; }
}

export function parseBdsTags(text: string): BdsTag[] {
  const tags: BdsTag[] = [];
  const matches = [...text.matchAll(TAG_RE)];

  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const start = match.index ?? 0;
    const lineEnd = text.indexOf("\n", start);
    const headerEnd = lineEnd === -1 ? text.length : lineEnd;
    const end = index + 1 < matches.length ? (matches[index + 1].index ?? text.length) : text.length;

    const raw = text.slice(start, end).trim();
    const body = text.slice(headerEnd === text.length ? text.length : headerEnd + 1, end);
    const attributes: Record<string, unknown> = {};
    for (const line of body.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const separator = trimmed.indexOf("=");
      if (separator <= 0) continue;
      const key = trimmed.slice(0, separator).trim();
      if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(key)) continue;
      attributes[key] = parseValue(trimmed.slice(separator + 1));
    }
    tags.push({ name: match[1], attributes, raw, start, end });
  }

  return tags;
}
