import { unzipSync, strFromU8 } from "fflate";
import { MAX_CHUNK_CHARS } from "./types.ts";
import type { GitFile, ParsedChunk } from "./types.ts";

export type GitHost = "github" | "gitlab";

export type ParsedRepo = {
  host: GitHost;
  owner: string;
  name: string;
  url: string;
};

const SKIP_DIR =
  /(^|\/)(\.git|node_modules|\.next|dist|build|coverage|vendor|\.venv|__pycache__|\.grok|\.turbo|\.cache|out)(\/|$)/i;
const SKIP_FILE =
  /\.(lock|min\.js|map|png|jpe?g|gif|webp|ico|svg|woff2?|ttf|eot|mp4|zip|gz|tgz|wasm|pdf|bin|exe|dll|so|dylib|class)$/i;
const CODE_EXT =
  /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|rb|php|c|cc|cpp|h|hpp|cs|swift|md|sql|yml|yaml|toml|json|sh|bash|css|scss|vue|svelte|txt|r|m|mm|scala)$/i;

const HINT_STOP = new Set([
  "http",
  "https",
  "www",
  "source",
  "src",
  "lib",
  "app",
  "the",
  "and",
  "for",
  "with",
  "from",
  "this",
  "that",
  "action",
  "items",
  "item",
  "meeting",
  "zoom",
  "teams",
  "google",
  "meet",
  "slack",
  "claude",
  "code",
  "session",
  "knowledge",
  "hub",
]);

export function parseGitUrl(input: string): ParsedRepo | null {
  const raw = (input ?? "").trim();
  if (!raw) return null;

  const ssh = raw.match(/^git@([^:]+):([^/]+)\/([^/\s]+?)(?:\.git)?$/i);
  if (ssh) {
    const host = hostOf(ssh[1] ?? "");
    if (!host) return null;
    return canonical(host, ssh[2]!, ssh[3]!);
  }

  const urlish = raw.replace(/^git\+/, "");
  try {
    const withProto = /^(https?:)?\/\//i.test(urlish)
      ? urlish.startsWith("http")
        ? urlish
        : `https:${urlish}`
      : urlish.includes("github.com") || urlish.includes("gitlab.com")
        ? `https://${urlish.replace(/^\/+/, "")}`
        : "";
    if (withProto) {
      const u = new URL(withProto);
      const host = hostOf(u.hostname);
      if (!host) return null;
      const parts = u.pathname.replace(/^\/+|\/+$/g, "").split("/");
      if (parts.length < 2) return null;
      return canonical(host, parts[0]!, parts[1]!);
    }
  } catch {
    /* fall through */
  }

  const short = raw.match(/^([A-Za-z0-9][\w.-]{0,38})\/([A-Za-z0-9_.-]{1,80})$/);
  if (short) return canonical("github", short[1]!, short[2]!);

  return null;
}

function hostOf(hostname: string): GitHost | null {
  const h = hostname.toLowerCase().replace(/^www\./, "");
  if (h === "github.com" || h.endsWith(".github.com")) return "github";
  if (h === "gitlab.com" || h.endsWith(".gitlab.com")) return "gitlab";
  return null;
}

function canonical(host: GitHost, owner: string, name: string): ParsedRepo {
  const cleanName = name.replace(/\.git$/i, "").replace(/[?#].*$/, "");
  const origin = host === "github" ? "https://github.com" : "https://gitlab.com";
  return {
    host,
    owner,
    name: cleanName,
    url: `${origin}/${owner}/${cleanName}`,
  };
}

export function collectRepoHints(texts: string[]): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  const add = (value: string) => {
    const t = value.replace(/\.git$/i, "").replace(/[)#.,]+$/g, "").trim();
    if (!t || t.length < 2 || t.length > 120) return;
    const key = t.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    found.push(t);
  };

  const blob = texts.filter(Boolean).join("\n");

  for (const m of blob.matchAll(
    /https?:\/\/(?:www\.)?(github|gitlab)\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/gi,
  )) {
    const host = m[1]!.toLowerCase() === "gitlab" ? "gitlab" : "github";
    add(`https://${host}.com/${m[2]}/${m[3]!.replace(/\.git$/i, "")}`);
  }

  for (const m of blob.matchAll(
    /\b(?:git@)?(?:github|gitlab)\.com[:/]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/gi,
  )) {
    add(`https://github.com/${m[1]}/${m[2]!.replace(/\.git$/i, "")}`);
  }

  for (const m of blob.matchAll(
    /\b(?:repo(?:sitory)?|codebase|git project)\s+(?:called|named|is|:)?\s*[`"']?([A-Za-z][A-Za-z0-9_.-]{1,60})/gi,
  )) {
    add(m[1]!);
  }

  for (const m of blob.matchAll(/\b([A-Za-z][A-Za-z0-9_.-]{0,38})\/([A-Za-z0-9_.-]{1,80})\b/g)) {
    const owner = m[1]!;
    const name = m[2]!.replace(/\.git$/i, "");
    if (HINT_STOP.has(owner.toLowerCase())) continue;
    if (HINT_STOP.has(name.toLowerCase())) continue;
    if (name.includes(".") && !/\.(js|ts|py|go|rs|md)$/i.test(name) && name.split(".").length > 2) {
      continue;
    }
    if (/^\d/.test(name)) continue;
    add(`${owner}/${name}`);
  }

  return found.slice(0, 10);
}

export function scoreRepoMatch(
  hints: string[],
  repo: { name: string; fullName: string; description?: string },
): number {
  if (hints.length === 0) return 0;
  let best = 0;
  const name = repo.name.toLowerCase();
  const full = repo.fullName.toLowerCase();
  const desc = (repo.description ?? "").toLowerCase();
  for (const hint of hints) {
    const h = hint.toLowerCase().replace(/^https?:\/\/(www\.)?(github|gitlab)\.com\//, "");
    if (full === h || `https://github.com/${full}` === hint.toLowerCase()) return 1;
    if (name === h) best = Math.max(best, 0.95);
    if (h.endsWith(`/${name}`) || h.endsWith(`/${full}`)) best = Math.max(best, 0.9);
    if (name.includes(h) || h.includes(name)) best = Math.max(best, 0.7);
    if (desc && h.length > 3 && desc.includes(h)) best = Math.max(best, 0.45);
  }
  return best;
}

export function pickRepoFiles(files: GitFile[], limit = 50): GitFile[] {
  const ranked = files
    .filter((f) => keepPath(f.path) && f.content.trim().length > 0)
    .map((f) => ({
      ...f,
      content: f.content.length > 80_000 ? `${f.content.slice(0, 80_000)}\n…` : f.content,
      rank: rankPath(f.path),
    }))
    .sort((a, b) => a.rank - b.rank || a.path.length - b.path.length);
  return ranked.slice(0, limit).map(({ path, content }) => ({ path, content }));
}

export function keepPath(path: string): boolean {
  if (!path || path.endsWith("/")) return false;
  if (SKIP_DIR.test(path)) return false;
  if (SKIP_FILE.test(path)) return false;
  if (!CODE_EXT.test(path) && !/(^|\/)(README|LICENSE|CHANGELOG)(\.|$)/i.test(path)) return false;
  return true;
}

function rankPath(path: string): number {
  const lower = path.toLowerCase();
  if (/^readme/i.test(path.split("/").pop() ?? "")) return 0;
  if (/(package\.json|pyproject\.toml|cargo\.toml|go\.mod|composer\.json)$/i.test(lower)) return 1;
  if (lower.startsWith("src/") || lower.includes("/src/")) return 2;
  if (/\.(ts|tsx|py|go|rs)$/i.test(lower)) return 3;
  if (lower.endsWith(".md")) return 4;
  return 5;
}

export function chunkGitFiles(files: GitFile[], repoLabel: string): ParsedChunk[] {
  const chunks: ParsedChunk[] = [];
  for (const file of pickRepoFiles(files)) {
    const parts = splitFile(file.content);
    parts.forEach((part, i) => {
      chunks.push({
        text: `${file.path}\n${part}`,
        sourceType: "git",
        timestamp: `${file.path}#${i + 1}`,
        sourceFile: `${repoLabel}:${file.path}`,
        chunkKind: "code",
      });
    });
  }
  return chunks;
}

function splitFile(content: string): string[] {
  const text = content.replace(/\r\n/g, "\n").trim();
  if (!text) return [];
  const max = Math.min(MAX_CHUNK_CHARS - 80, 1800);
  if (text.length <= max) return [text];
  const lines = text.split("\n");
  const out: string[] = [];
  let buf: string[] = [];
  let size = 0;
  for (const line of lines) {
    if (size + line.length + 1 > max && buf.length) {
      out.push(buf.join("\n"));
      buf = [];
      size = 0;
    }
    buf.push(line);
    size += line.length + 1;
  }
  if (buf.length) out.push(buf.join("\n"));
  return out.slice(0, 8);
}

export function filesFromZipBuffer(buffer: ArrayBuffer | Uint8Array): GitFile[] {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let unpacked: Record<string, Uint8Array>;
  try {
    unpacked = unzipSync(bytes, {
      filter: (file) => {
        if (file.originalSize > 80_000) return false;
        const path = stripZipRoot(file.name);
        return keepPath(path);
      },
    });
  } catch {
    return [];
  }
  const files: GitFile[] = [];
  for (const [rawPath, data] of Object.entries(unpacked)) {
    const path = stripZipRoot(rawPath);
    if (!keepPath(path)) continue;
    let content = "";
    try {
      content = strFromU8(data);
    } catch {
      continue;
    }
    if (!content.trim()) continue;
    if (content.includes("\u0000")) continue;
    files.push({ path, content });
  }
  return pickRepoFiles(files);
}

function stripZipRoot(name: string): string {
  const parts = name.replace(/\\/g, "/").split("/");
  if (parts.length > 1 && !parts[0]!.includes(".")) return parts.slice(1).join("/");
  return name.replace(/\\/g, "/");
}

export function formatRepoLabel(repo: { owner: string; name: string }): string {
  return `${repo.owner}/${repo.name}`;
}
