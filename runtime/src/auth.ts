export function extractBearer(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() || null;
}

export function authenticateBearer(header: string | undefined, expected: string): boolean {
  const token = extractBearer(header);
  return token !== null && token.length === expected.length && token === expected;
}
