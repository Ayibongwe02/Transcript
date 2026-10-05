/** Stable 16-char id — same inputs always produce the same id (idempotent upserts). */
export function chunkId(sourceFile: string, timestamp: string, text: string): string {
  const raw = `${sourceFile}|${timestamp}|${text.slice(0, 80)}`;
  return fnvHex(raw, 16);
}

export function randomId(prefix = "id"): string {
  const n =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().replace(/-/g, "").slice(0, 12)
      : Math.random().toString(16).slice(2, 14);
  return `${prefix}_${n}`;
}

function fnvHex(raw: string, length: number): string {
  let h1 = 2166136261;
  let h2 = 1597334677;
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    h1 ^= c;
    h1 = Math.imul(h1, 16777619);
    h2 ^= c;
    h2 = Math.imul(h2, 2246822519);
  }
  const a = (h1 >>> 0).toString(16).padStart(8, "0");
  const b = (h2 >>> 0).toString(16).padStart(8, "0");
  return (a + b).slice(0, length);
}
