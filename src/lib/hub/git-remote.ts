import { createServerFn } from "@tanstack/react-start";
import {
  filesFromZipBuffer,
  parseGitUrl,
  pickRepoFiles,
  scoreRepoMatch,
  type ParsedRepo,
} from "./git.ts";
import type { GitFile } from "./types.ts";

export type GitRepoHit = {
  owner: string;
  name: string;
  fullName: string;
  url: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  score: number;
};

export type FetchGitOk = {
  ok: true;
  owner: string;
  name: string;
  url: string;
  defaultBranch: string;
  origin: "github" | "gitlab" | "url";
  files: GitFile[];
};

export type GitErr = { ok: false; error: string; needsUrl?: boolean };

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { raw: text };
  }
}

function ghHeaders(token?: string): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "knowledge-hub",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

async function githubJson(path: string, token?: string): Promise<{ ok: true; body: unknown } | GitErr> {
  try {
    const res = await fetch(`https://api.github.com${path}`, {
      headers: ghHeaders(token),
      signal: AbortSignal.timeout(20000),
    });
    const body = await readJson(res);
    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        error: "GitHub refused the token. Sign in again, or paste a git URL as a last resort.",
        needsUrl: true,
      };
    }
    if (res.status === 404) {
      return { ok: false, error: "Repository not found (or it is private without a token).", needsUrl: true };
    }
    if (!res.ok) {
      const rec = asRecord(body);
      return {
        ok: false,
        error: str(rec?.message) || `GitHub API ${res.status}`,
        needsUrl: res.status === 429,
      };
    }
    return { ok: true, body };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "GitHub request failed", needsUrl: true };
  }
}

function toHit(raw: unknown, hints: string[]): GitRepoHit | null {
  const r = asRecord(raw);
  if (!r) return null;
  const fullName = str(r.full_name);
  const [owner, name] = fullName.split("/");
  if (!owner || !name) return null;
  return {
    owner,
    name,
    fullName,
    url: str(r.html_url) || `https://github.com/${fullName}`,
    description: str(r.description),
    private: r.private === true,
    defaultBranch: str(r.default_branch) || "main",
    score: scoreRepoMatch(hints, { name, fullName, description: str(r.description) }),
  };
}

async function loadUserRepos(
  token: string,
  query: string,
): Promise<{ ok: true; repos: GitRepoHit[]; login: string } | GitErr> {
  const me = await githubJson("/user", token);
  if (!me.ok) return me;
  const login = str(asRecord(me.body)?.login);
  const list = await githubJson(
    "/user/repos?per_page=80&sort=updated&affiliation=owner,collaborator,organization_member",
    token,
  );
  if (!list.ok) return list;
  const hints = query ? [query, ...query.split(/\s+/)] : [];
  const repos = asArray(list.body)
    .map((raw) => toHit(raw, hints))
    .filter((r): r is GitRepoHit => Boolean(r));
  repos.sort((a, b) => b.score - a.score || a.fullName.localeCompare(b.fullName));
  return { ok: true, repos: repos.slice(0, 40), login };
}

async function loadGithubMeta(
  owner: string,
  name: string,
  token?: string,
): Promise<{ ok: true; hit: GitRepoHit } | GitErr> {
  const res = await githubJson(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`, token);
  if (!res.ok) return res;
  const hit = toHit(res.body, [`${owner}/${name}`]);
  if (!hit) return { ok: false, error: "Repository metadata missing.", needsUrl: true };
  hit.score = 1;
  return { ok: true, hit };
}

async function downloadZip(url: string, token?: string): Promise<{ ok: true; bytes: Uint8Array } | GitErr> {
  try {
    const headers: Record<string, string> = { "User-Agent": "knowledge-hub", Accept: "application/zip" };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(40000), redirect: "follow" });
    if (res.status === 404) {
      return { ok: false, error: "Could not download the repository archive.", needsUrl: true };
    }
    if (!res.ok) {
      return { ok: false, error: `Archive download failed (${res.status}).`, needsUrl: true };
    }
    const len = Number(res.headers.get("content-length") ?? "0");
    if (len > 8_000_000) {
      return { ok: false, error: "Repository archive is too large to index in the hub.", needsUrl: true };
    }
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength > 8_000_000) {
      return { ok: false, error: "Repository archive is too large to index in the hub.", needsUrl: true };
    }
    return { ok: true, bytes: buf };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Archive download failed", needsUrl: true };
  }
}

async function fetchViaTree(owner: string, name: string, branch: string, token?: string): Promise<GitFile[]> {
  const tree = await githubJson(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
    token,
  );
  if (!tree.ok) return [];
  const rec = asRecord(tree.body);
  const entries = asArray(rec?.tree)
    .map((raw) => asRecord(raw))
    .filter((e): e is Record<string, unknown> => Boolean(e) && str(e?.type) === "blob")
    .map((e) => ({ path: str(e.path), sha: str(e.sha), size: Number(e.size ?? 0) }))
    .filter((e) => e.path && e.size > 0 && e.size <= 80_000);

  const wanted = pickRepoFiles(
    entries.map((e) => ({ path: e.path, content: "x" })),
    40,
  ).map((f) => f.path);
  const byPath = new Map(entries.map((e) => [e.path, e]));
  const files: GitFile[] = [];
  for (const path of wanted) {
    const entry = byPath.get(path);
    if (!entry) continue;
    const blob = await githubJson(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/contents/${encodeURIComponent(path)}`,
      token,
    );
    if (!blob.ok) continue;
    const body = asRecord(blob.body);
    const encoding = str(body?.encoding);
    const raw = str(body?.content).replace(/\n/g, "");
    let content = "";
    if (encoding === "base64" && raw) {
      try {
        content = Buffer.from(raw, "base64").toString("utf8");
      } catch {
        continue;
      }
    } else {
      content = str(body?.content);
    }
    if (content) files.push({ path, content });
  }
  return files;
}

export const listGithubRepos = createServerFn({ method: "POST" })
  .validator((input: { accessToken: string; query?: string }) => ({
    accessToken: (input?.accessToken ?? "").trim(),
    query: (input?.query ?? "").trim().slice(0, 200),
  }))
  .handler(async ({ data }): Promise<{ ok: true; repos: GitRepoHit[]; login: string } | GitErr> => {
    if (!data.accessToken) {
      return { ok: false, error: "No GitHub token. Sign in or paste a PAT.", needsUrl: true };
    }
    return loadUserRepos(data.accessToken, data.query);
  });

export const resolveGitFromHints = createServerFn({ method: "POST" })
  .validator((input: { hints: string[]; accessToken?: string }) => ({
    hints: Array.isArray(input?.hints) ? input.hints.map((h) => String(h).slice(0, 160)).slice(0, 10) : [],
    accessToken: (input?.accessToken ?? "").trim() || undefined,
  }))
  .handler(
    async ({
      data,
    }): Promise<
      { ok: true; match: GitRepoHit | null; candidates: GitRepoHit[]; needsUrl: boolean } | GitErr
    > => {
      const urlHint = data.hints.map((h) => parseGitUrl(h)).find((p): p is ParsedRepo => Boolean(p));
      if (urlHint) {
        const meta = await loadGithubMeta(urlHint.owner, urlHint.name, data.accessToken);
        if (meta.ok) {
          return { ok: true, match: meta.hit, candidates: [meta.hit], needsUrl: false };
        }
      }

      if (!data.accessToken) {
        return { ok: true, match: null, candidates: [], needsUrl: true };
      }

      const listed = await loadUserRepos(data.accessToken, data.hints[0] ?? "");
      if (!listed.ok) {
        return { ok: true, match: null, candidates: [], needsUrl: true };
      }

      const scored = listed.repos
        .map((r) => ({ ...r, score: Math.max(r.score, scoreRepoMatch(data.hints, r)) }))
        .filter((r) => r.score >= 0.7)
        .sort((a, b) => b.score - a.score);

      if (scored.length === 1 && scored[0]!.score >= 0.9) {
        return { ok: true, match: scored[0]!, candidates: scored, needsUrl: false };
      }
      if (scored.length > 0) {
        return { ok: true, match: null, candidates: scored.slice(0, 8), needsUrl: false };
      }
      return { ok: true, match: null, candidates: listed.repos.slice(0, 6), needsUrl: true };
    },
  );

export const fetchGitRepo = createServerFn({ method: "POST" })
  .validator((input: { url?: string; owner?: string; name?: string; accessToken?: string }) => ({
    url: (input?.url ?? "").trim().slice(0, 400),
    owner: (input?.owner ?? "").trim().slice(0, 80),
    name: (input?.name ?? "").trim().slice(0, 80),
    accessToken: (input?.accessToken ?? "").trim() || undefined,
  }))
  .handler(async ({ data }): Promise<FetchGitOk | GitErr> => {
    const parsed =
      parseGitUrl(data.url) ||
      (data.owner && data.name ? parseGitUrl(`${data.owner}/${data.name}`) : null);
    if (!parsed) {
      return {
        ok: false,
        error: "Could not parse that git location. Use owner/name or a GitHub/GitLab URL.",
        needsUrl: true,
      };
    }

    if (parsed.host === "gitlab") {
      const project = encodeURIComponent(`${parsed.owner}/${parsed.name}`);
      const zip = await downloadZip(
        `https://gitlab.com/api/v4/projects/${project}/repository/archive.zip`,
        data.accessToken,
      );
      if (!zip.ok) return zip;
      const files = filesFromZipBuffer(zip.bytes);
      if (files.length === 0) {
        return { ok: false, error: "No indexable source files in that GitLab project.", needsUrl: true };
      }
      return {
        ok: true,
        owner: parsed.owner,
        name: parsed.name,
        url: parsed.url,
        defaultBranch: "main",
        origin: "gitlab",
        files,
      };
    }

    const meta = await loadGithubMeta(parsed.owner, parsed.name, data.accessToken);
    const branch = meta.ok ? meta.hit.defaultBranch : "main";
    const htmlUrl = meta.ok ? meta.hit.url : parsed.url;

    const zipUrl = data.accessToken
      ? `https://api.github.com/repos/${parsed.owner}/${parsed.name}/zipball/${encodeURIComponent(branch)}`
      : `https://codeload.github.com/${parsed.owner}/${parsed.name}/zip/refs/heads/${encodeURIComponent(branch)}`;

    const zip = await downloadZip(zipUrl, data.accessToken);
    let files: GitFile[] = [];
    if (zip.ok) files = filesFromZipBuffer(zip.bytes);

    if (files.length === 0 && data.accessToken) {
      files = await fetchViaTree(parsed.owner, parsed.name, branch, data.accessToken);
    }

    if (files.length === 0) {
      return {
        ok: false,
        error:
          "Could not read files from that repository. If it is private, connect GitHub; otherwise paste a different git URL.",
        needsUrl: true,
      };
    }

    return {
      ok: true,
      owner: parsed.owner,
      name: parsed.name,
      url: htmlUrl,
      defaultBranch: branch,
      origin: data.url && !data.accessToken ? "url" : "github",
      files,
    };
  });
