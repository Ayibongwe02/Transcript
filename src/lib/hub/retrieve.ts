import type { Chunk, RetrievedChunk, SourceType } from "./types.ts";
import { DEFAULT_TOP_K, MINUTES_SOURCE_TYPES } from "./types.ts";

const STOP = new Set([
  "the",
  "a",
  "an",
  "of",
  "and",
  "to",
  "in",
  "is",
  "it",
  "for",
  "on",
  "with",
  "as",
  "be",
  "at",
  "by",
  "or",
  "from",
  "that",
  "this",
  "was",
  "are",
  "we",
  "our",
  "you",
  "i",
  "me",
  "my",
  "do",
  "does",
  "did",
  "what",
  "who",
  "how",
  "when",
  "where",
  "which",
  "can",
  "could",
  "should",
  "would",
  "will",
  "just",
  "about",
  "into",
  "than",
  "then",
  "so",
  "if",
  "not",
  "no",
  "yes",
]);

const MINUTES_Q = /\b(minutes|action items?|decisions?|attendees|recap|summary|who owns|agreed)\b/i;
const GIT_Q = /\b(git|repo(?:sitory)?|codebase|source file|function|class|claude code|implementation)\b/i;

export type RetrieveFilter = SourceType | "all" | "minutes";

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOP.has(t));
}

/**
 * Local BM25-ish retrieval over in-browser chunks.
 * Lower `score` is better (distance analog, matching the original Chroma API).
 */
export function retrieve(
  question: string,
  chunks: Chunk[],
  topK = DEFAULT_TOP_K,
  filterType?: RetrieveFilter,
): RetrievedChunk[] {
  let pool = chunks;
  if (filterType === "minutes") {
    pool = chunks.filter(
      (c) =>
        MINUTES_SOURCE_TYPES.includes(c.sourceType) ||
        c.chunkKind === "summary" ||
        c.chunkKind === "decision" ||
        c.chunkKind === "action" ||
        c.chunkKind === "minutes",
    );
  } else if (filterType && filterType !== "all") {
    pool = chunks.filter((c) => c.sourceType === filterType);
  }
  if (pool.length === 0) return [];

  const qTokens = tokenize(question);
  if (qTokens.length === 0) {
    return pool.slice(0, topK).map((c) => toRetrieved(c, 1));
  }

  const wantMinutes = MINUTES_Q.test(question) || filterType === "minutes";
  const wantGit = GIT_Q.test(question) || filterType === "git";

  const df = new Map<string, number>();
  const docs = pool.map((c) => {
    const tokens = tokenize(
      `${c.text} ${c.sourceFile} ${c.sourceType.replace("_", " ")} ${c.chunkKind}`,
    );
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    for (const t of new Set(tokens)) df.set(t, (df.get(t) ?? 0) + 1);
    return { chunk: c, tf, len: tokens.length };
  });

  const N = docs.length;
  const avgLen = docs.reduce((s, d) => s + d.len, 0) / Math.max(N, 1);
  const k1 = 1.4;
  const b = 0.75;

  const scored: RetrievedChunk[] = docs.map((d) => {
    let bm25 = 0;
    for (const t of qTokens) {
      const f = d.tf.get(t) ?? 0;
      if (!f) continue;
      const n = df.get(t) ?? 0;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      const denom = f + k1 * (1 - b + b * (d.len / avgLen));
      bm25 += idf * ((f * (k1 + 1)) / denom);
    }
    if (wantMinutes && d.chunk.chunkKind && d.chunk.chunkKind !== "turn") {
      bm25 *= 1.35;
    }
    if (wantGit && (d.chunk.sourceType === "git" || d.chunk.sourceType === "code_session")) {
      bm25 *= 1.3;
    }
    const maxPossible = qTokens.length * Math.log(1 + (N + 0.5) / 0.5);
    const similarity = maxPossible > 0 ? Math.min(1, bm25 / maxPossible) : 0;
    return toRetrieved(d.chunk, 1 - similarity);
  });

  scored.sort((a, b) => a.score - b.score);

  const k = Math.min(topK, scored.length);
  const picked: RetrievedChunk[] = [];
  const used = new Set<string>();

  const typesPresent = new Set(
    scored.filter((s) => s.score < 0.94).map((s) => s.sourceType),
  );
  if (typesPresent.size > 1 && (!filterType || filterType === "all" || filterType === "minutes")) {
    for (const type of typesPresent) {
      const best = scored.find((s) => s.sourceType === type && !used.has(s.id));
      if (best && picked.length < k) {
        picked.push(best);
        used.add(best.id);
      }
    }
  }

  for (const s of scored) {
    if (picked.length >= k) break;
    if (used.has(s.id)) continue;
    picked.push(s);
    used.add(s.id);
  }

  picked.sort((a, b) => a.score - b.score);
  const strong = picked.filter((s) => s.score < 0.96);
  return strong.length ? strong : picked.slice(0, 1);
}

export function isWeakMatch(results: RetrievedChunk[]): boolean {
  if (results.length === 0) return true;
  const best = Math.min(...results.map((r) => r.score));
  return best > 0.88;
}

function toRetrieved(c: Chunk, score: number): RetrievedChunk {
  return {
    text: c.text,
    sourceType: c.sourceType,
    timestamp: c.timestamp,
    sourceFile: c.sourceFile,
    score,
    id: c.id,
    chunkKind: c.chunkKind,
  };
}
