export interface MathBoundingBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface MathSection {
  id: string;
  title: string;
  level: number;
  page_start?: number;
  page_end?: number;
}

export interface MathEquation {
  id: string;
  latex: string;
  number?: string;
  page?: number;
  bounding_box?: MathBoundingBox;
  confidence?: number | null;
}

export interface MathFigure {
  id: string;
  caption?: string;
  image?: string;
  page?: number;
  bounding_box?: MathBoundingBox;
  tikz?: string;
  objects: string[];
  relations: string[];
}

export interface MathTable {
  id: string;
  caption?: string;
  page?: number;
  content?: string;
}

export interface MathReference {
  id: string;
  label?: string;
  text: string;
  page?: number;
}

export interface MathTheorem {
  id: string;
  kind: "theorem" | "lemma" | "proposition" | "corollary" | "definition" | "proof";
  title?: string;
  text: string;
  page?: number;
  dependencies: string[];
  references: string[];
}

export interface MathRelation {
  type: "depends_on" | "references" | "contains" | "follows";
  from: string;
  to: string;
}

export interface MathIRDocument {
  id: string;
  title: string;
  source_path: string;
  created_at: string;
  pages: number;
  sections: MathSection[];
  equations: MathEquation[];
  theorems: MathTheorem[];
  figures: MathFigure[];
  tables: MathTable[];
  references: MathReference[];
  relations: MathRelation[];
  metadata: Record<string, unknown>;
}

export interface MathIrSearchResult {
  id: string;
  kind: string;
  title: string;
  text: string;
  page?: number;
  score: number;
}

function tokens(value: string): string[] {
  return value.toLowerCase().match(/[a-z0-9][a-z0-9._-]{2,}/g) ?? [];
}

function score(query: string, text: string): number {
  const terms = new Set(tokens(query));
  if (!terms.size) return 0;
  const hay = text.toLowerCase();
  let hits = 0;
  for (const term of terms) if (hay.includes(term)) hits += 1;
  return hits / terms.size;
}

export function searchMathIR(doc: MathIRDocument, query: string, limit = 20): MathIrSearchResult[] {
  const results: MathIrSearchResult[] = [];
  for (const theorem of doc.theorems) {
    const s = score(query, `${theorem.kind} ${theorem.title ?? ""} ${theorem.text}`);
    if (s > 0) results.push({ id: theorem.id, kind: theorem.kind, title: theorem.title ?? theorem.id, text: theorem.text, page: theorem.page, score: s });
  }
  for (const equation of doc.equations) {
    const s = score(query, `${equation.number ?? ""} ${equation.latex}`);
    if (s > 0) results.push({ id: equation.id, kind: "equation", title: equation.number ? `Equation ${equation.number}` : equation.id, text: equation.latex, page: equation.page, score: s });
  }
  for (const section of doc.sections) {
    const s = score(query, section.title);
    if (s > 0) results.push({ id: section.id, kind: "section", title: section.title, text: section.title, page: section.page_start, score: s });
  }
  return results.sort((a, b) => b.score - a.score).slice(0, Math.max(1, Math.min(50, limit)));
}

export function buildReasoningContext(doc: MathIRDocument, query: string, limit = 20): string {
  const results = searchMathIR(doc, query, limit);
  const byId = new Map<string, MathTheorem>(doc.theorems.map((item) => [item.id, item]));
  const lines: string[] = [`[MATHIR] document=${doc.id} title=${doc.title}`];
  for (const result of results) {
    lines.push(`- ${result.kind} ${result.id}${result.page ? ` page=${result.page}` : ""}: ${result.text}`);
    const theorem = byId.get(result.id);
    if (theorem?.dependencies.length) lines.push(`  dependencies: ${theorem.dependencies.join(", ")}`);
    if (theorem?.references.length) lines.push(`  references: ${theorem.references.join(", ")}`);
  }
  lines.push("[/MATHIR]");
  return lines.join("\n").slice(0, 120_000);
}
