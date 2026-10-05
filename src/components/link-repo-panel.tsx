import { useState } from "react";
import { GitBranch, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { collectRepoHints } from "@/lib/hub/git";
import { fetchGitRepo, resolveGitFromHints, type GitRepoHit } from "@/lib/hub/git-remote";
import { accessTokenFor } from "@/lib/hub/secrets";
import { useHub } from "@/lib/hub/store";
import type { MeetingRecord } from "@/lib/hub/types";

export function LinkRepoPanel({ meeting }: { meeting: MeetingRecord }) {
  const repos = useHub((s) => s.repos);
  const chunks = useHub((s) => s.chunks);
  const ingestGitRepo = useHub((s) => s.ingestGitRepo);
  const patchMeeting = useHub((s) => s.patchMeeting);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [picks, setPicks] = useState<GitRepoHit[]>([]);

  const linked = repos.find((r) => r.id === meeting.linkedRepoId) ?? null;
  const status = meeting.repoStatus ?? "idle";

  function hintsFor(m: MeetingRecord): string[] {
    const extra = chunks
      .filter((c) => c.documentId === m.documentId || c.sourceType === "code_session")
      .slice(0, 40)
      .map((c) => c.text);
    return collectRepoHints([
      m.title,
      m.summary,
      m.sourceFile,
      ...m.decisions,
      ...m.actionItems.map((a) => `${a.owner} ${a.text}`),
      ...extra,
    ]);
  }

  async function indexHit(hit: GitRepoHit, originUrl?: string) {
    const token = accessTokenFor("git") ?? undefined;
    const fetched = await fetchGitRepo({
      data: {
        owner: hit.owner,
        name: hit.name,
        url: originUrl || hit.url,
        accessToken: token,
      },
    });
    if (!fetched.ok) {
      patchMeeting(meeting.id, {
        repoStatus: fetched.needsUrl ? "needs_url" : "failed",
        repoHint: fetched.error,
      });
      toast.error(fetched.error);
      return;
    }
    const res = ingestGitRepo({
      owner: fetched.owner,
      name: fetched.name,
      url: fetched.url,
      defaultBranch: fetched.defaultBranch,
      files: fetched.files,
      origin: fetched.origin,
      meetingId: meeting.id,
    });
    if (!res.ok) {
      patchMeeting(meeting.id, { repoStatus: "failed", repoHint: res.error });
      toast.error(res.error);
      return;
    }
    setPicks([]);
    toast.success(`Indexed ${fetched.owner}/${fetched.name} · ${res.chunks} chunks`);
  }

  async function reviewWithGit() {
    setBusy(true);
    setPicks([]);
    patchMeeting(meeting.id, { repoStatus: "searching", repoHint: null });
    try {
      const hints = hintsFor(meeting);
      const token = accessTokenFor("git") ?? undefined;
      const resolved = await resolveGitFromHints({
        data: { hints, accessToken: token },
      });
      if (!resolved.ok) {
        patchMeeting(meeting.id, {
          repoStatus: "needs_url",
          repoHint: resolved.error,
          repoCandidates: hints,
        });
        return;
      }
      if (resolved.match) {
        await indexHit(resolved.match);
        return;
      }
      if (resolved.candidates.length > 0 && !resolved.needsUrl) {
        setPicks(resolved.candidates);
        patchMeeting(meeting.id, {
          repoStatus: "idle",
          repoHint: "Pick the project Claude Code is on.",
          repoCandidates: resolved.candidates.map((c) => c.fullName),
        });
        return;
      }
      patchMeeting(meeting.id, {
        repoStatus: "needs_url",
        repoHint:
          "Could not reach this project through GitHub / Claude Code. Paste the git URL as a last resort.",
        repoCandidates: hints,
      });
    } catch (e) {
      patchMeeting(meeting.id, {
        repoStatus: "needs_url",
        repoHint: e instanceof Error ? e.message : "Git lookup failed",
      });
    } finally {
      setBusy(false);
    }
  }

  async function indexFromUrl() {
    const value = url.trim();
    if (!value) {
      toast.error("Paste a git URL first.");
      return;
    }
    setBusy(true);
    try {
      const token = accessTokenFor("git") ?? undefined;
      const fetched = await fetchGitRepo({ data: { url: value, accessToken: token } });
      if (!fetched.ok) {
        patchMeeting(meeting.id, { repoStatus: "failed", repoHint: fetched.error });
        toast.error(fetched.error);
        return;
      }
      const res = ingestGitRepo({
        owner: fetched.owner,
        name: fetched.name,
        url: fetched.url,
        defaultBranch: fetched.defaultBranch,
        files: fetched.files,
        origin: "url",
        meetingId: meeting.id,
      });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      setUrl("");
      toast.success(`Indexed ${fetched.owner}/${fetched.name} · ${res.chunks} chunks`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mt-8 rounded-xl bg-surface p-4 shadow-[var(--shadow-border)]">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="flex items-center gap-2 text-xs font-medium tracking-wider text-muted uppercase">
            <GitBranch className="size-3.5" />
            Git / Claude Code
          </h3>
          {linked ? (
            <p className="mt-2 text-sm text-fg">
              Linked to{" "}
              <span className="font-mono text-accent">
                {linked.owner}/{linked.name}
              </span>
              <span className="text-muted">
                {" "}
                · {linked.fileCount} files · {linked.chunkCount} chunks
              </span>
            </p>
          ) : (
            <p className="mt-2 text-sm text-muted">
              Link the repo this meeting was about so the brief can propose patches against real
              code.
            </p>
          )}
          {status === "searching" && (
            <p className="mt-2 text-xs text-subtle">Looking up the project on GitHub…</p>
          )}
          {(status === "failed" || status === "needs_url") && meeting.repoHint ? (
            <p className="mt-2 text-sm text-warn">{meeting.repoHint}</p>
          ) : null}
        </div>
        <Button
          size="sm"
          variant={linked ? "secondary" : "default"}
          disabled={busy}
          onClick={() => void reviewWithGit()}
        >
          {busy ? <Loader2 className="animate-spin" /> : <GitBranch />}
          {linked ? "Re-index repo" : "Review with git"}
        </Button>
      </div>

      {picks.length > 0 && (
        <ul className="mt-3 flex flex-col gap-1">
          {picks.map((p) => (
            <li key={p.fullName}>
              <button
                type="button"
                disabled={busy}
                onClick={() => void indexHit(p)}
                className="flex min-h-11 w-full items-center justify-between gap-2 rounded-sm bg-surface px-3 py-2 text-left text-sm text-fg"
              >
                <span className="font-mono text-xs">{p.fullName}</span>
                <span className="truncate text-xs text-muted">{p.description || "Index this repo"}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {(status === "needs_url" || status === "failed") && (
        <div className="mt-4">
          <Label htmlFor={`git-url-${meeting.id}`}>Git URL (last resort)</Label>
          <div className="mt-1.5 flex flex-col gap-2 sm:flex-row">
            <Input
              id={`git-url-${meeting.id}`}
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://github.com/org/project"
              autoComplete="off"
            />
            <Button size="sm" disabled={busy || !url.trim()} onClick={() => void indexFromUrl()}>
              {busy ? <Loader2 className="animate-spin" /> : null}
              Index URL
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
