import { randomUUID } from "node:crypto";
import type { RuntimeStore } from "./store.js";
import { buildReasoningContext, type MathIRDocument } from "./mathir.js";

export interface MathAskRequest {
  document_id: string;
  question: string;
  max_context_items?: number;
}

export interface MathAskResult {
  id: string;
  document_id: string;
  question: string;
  context: string;
  answer: string;
  citations: Array<{ id: string; page?: number; kind: string }>;
  provider: "local-context" | "deepseek-api";
}

function matchingCitations(doc: MathIRDocument, question: string): MathAskResult["citations"] {
  const terms = question.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [];
  const items: MathAskResult["citations"] = [];
  const seen = new Set<string>();
  for (const theorem of doc.theorems) {
    const text = `${theorem.kind} ${theorem.title ?? ""} ${theorem.text}`.toLowerCase();
    if (terms.some((term) => text.includes(term)) && !seen.has(theorem.id)) {
      items.push({ id: theorem.id, page: theorem.page, kind: theorem.kind });
      seen.add(theorem.id);
    }
  }
  for (const equation of doc.equations) {
    const text = `${equation.number ?? ""} ${equation.latex}`.toLowerCase();
    if (terms.some((term) => text.includes(term)) && !seen.has(equation.id)) {
      items.push({ id: equation.id, page: equation.page, kind: "equation" });
      seen.add(equation.id);
    }
  }
  return items.slice(0, 20);
}

async function askDeepSeek(context: string, question: string): Promise<string | null> {
  const endpoint = String(process.env.BDS_DEEPSEEK_API_URL ?? "").trim();
  const key = String(process.env.BDS_DEEPSEEK_API_KEY ?? "").trim();
  if (!endpoint || !key) return null;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ messages: [
      { role: "system", content: "Answer only from the supplied [MATHIR] context. State when the context is incomplete. Cite MathIR entity ids for factual claims. Never claim a proof is valid merely because text was extracted." },
      { role: "user", content: `${context}\n\nQuestion: ${question}` },
    ] }),
  });
  if (!response.ok) throw new Error(`DeepSeek API returned ${response.status}`);
  const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  const text = data.choices?.[0]?.message?.content;
  return typeof text === "string" && text.trim() ? text.trim() : null;
}

export async function askMathDocument(request: MathAskRequest, store: RuntimeStore): Promise<MathAskResult> {
  if (!request?.document_id) throw new Error("document_id is required");
  if (!request.question?.trim()) throw new Error("question is required");
  const row = store.getMathDocument(request.document_id);
  if (!row) throw new Error("MathIR document not found");
  const document = row.document as MathIRDocument;
  const context = buildReasoningContext(document, request.question, request.max_context_items ?? 20);
  const citations = matchingCitations(document, request.question);
  const remoteAnswer = await askDeepSeek(context, request.question);
  const answer = remoteAnswer ?? `Local MathIR retrieval found ${citations.length} directly matching entities.\n\n${citations.map((item) => `- ${item.id}${item.page ? ` (page ${item.page})` : ""} — ${item.kind}`).join("\n") || "No directly matching theorem/equation was found."}\n\nThe original PDF was not sent to a model.`;
  const result: MathAskResult = { id: `ask_${randomUUID().replaceAll("-", "").slice(0, 16)}`, document_id: request.document_id, question: request.question, context, answer, citations, provider: remoteAnswer ? "deepseek-api" : "local-context" };
  store.audit("math.ask", { id: result.id, document_id: result.document_id, provider: result.provider, citation_count: citations.length });
  return result;
}
