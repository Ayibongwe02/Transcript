import type { RetrievedChunk } from "./types.ts";

export function fallbackAnswer(chunks: RetrievedChunk[]): string {
  if (chunks.length === 0) {
    return "No relevant context found in the indexed sources for this question.";
  }
  const top = chunks[0];
  const kind = top.sourceType.replaceAll("_", " ");
  return (
    `Closest match: ${kind} · ${top.sourceFile} · ${top.timestamp} [Source 1]. ` +
    `${top.text.slice(0, 280)}${top.text.length > 280 ? "…" : ""} ` +
    `The writer is offline, so treat the ranked passages below as the answer.`
  );
}
