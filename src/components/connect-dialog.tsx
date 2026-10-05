import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { DropZone } from "@/components/drop-zone";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { redirectToLoginIfRequired } from "@/lib/app-data/login";
import { filesFromZipBuffer } from "@/lib/hub/git";
import { fetchGitRepo, listGithubRepos, type GitRepoHit } from "@/lib/hub/git-remote";
import { ingestRemoteMeetings } from "@/lib/hub/ingest-remote";
import {
  beginOAuth,
  clearPendingOAuth,
  OAUTH_PROVIDERS,
  redirectUri,
  waitForOAuthCode,
} from "@/lib/hub/oauth";
import {
  exchangeOAuthCode,
  syncGrokGoogleMeet,
  syncGrokTeams,
  syncRemoteSource,
} from "@/lib/hub/remote";
import {
  SAMPLE_GMEET_RECAP,
  SAMPLE_GIT_FILES,
  SAMPLE_SLACK,
  SAMPLE_TEAMS_STANDUP,
  SAMPLE_ZOOM_MINUTES,
} from "@/lib/hub/sample-data";
import {
  accessTokenFor,
  maskedHint,
  oauthBundle,
  saveClientApp,
  savedClientId,
  saveOAuth,
} from "@/lib/hub/secrets";
import { useHub } from "@/lib/hub/store";
import {
  CONNECTOR_LABELS,
  OAUTH_CONNECTORS,
  type ConnectorKind,
  type OAuthConnector,
  type SourceType,
} from "@/lib/hub/types";
import { cn } from "@/lib/utils";

type Mode = "auth" | "token" | "import";

const CARD_META: Record<
  ConnectorKind,
  { ingestHint: string; tokenLabel: string; tokenHint: string; accept: string }
> = {
  folder: {
    ingestHint: ".txt, .log, .md, .vtt, .json",
    tokenLabel: "",
    tokenHint: "",
    accept: ".txt,.log,.md,.json,.vtt",
  },
  slack: {
    ingestHint: "Slack JSON or text export",
    tokenLabel: "Bot token",
    tokenHint: "xoxb-… from your Slack app",
    accept: ".json,.txt",
  },
  readai: {
    ingestHint: "Read AI transcript or notes",
    tokenLabel: "API key",
    tokenHint: "Read AI API key",
    accept: ".txt,.md,.json",
  },
  whatsapp: {
    ingestHint: "WhatsApp .txt export",
    tokenLabel: "Cloud API token",
    tokenHint: "WhatsApp Cloud API token (optional)",
    accept: ".txt",
  },
  zoom: {
    ingestHint: "Zoom VTT, summary, or JSON",
    tokenLabel: "Access token or JWT",
    tokenHint: "Zoom OAuth access token or Server-to-Server token",
    accept: ".txt,.vtt,.json,.md",
  },
  gmeet: {
    ingestHint: "Meet recap, VTT, or notes",
    tokenLabel: "Google access token",
    tokenHint: "OAuth access token with Calendar read",
    accept: ".txt,.vtt,.md,.json",
  },
  teams: {
    ingestHint: "Teams transcript, VTT, or chat export",
    tokenLabel: "Microsoft Graph token",
    tokenHint: "Delegated token with Calendars.Read",
    accept: ".txt,.vtt,.md,.json",
  },
  git: {
    ingestHint: "source files or a project zip from Claude Code",
    tokenLabel: "GitHub personal access token",
    tokenHint: "ghp_… with repo scope",
    accept: ".zip,.ts,.tsx,.js,.py,.go,.rs,.md,.json,.txt",
  },
};

function isOAuth(kind: ConnectorKind): kind is OAuthConnector {
  return (OAUTH_CONNECTORS as readonly string[]).includes(kind);
}

export function ConnectDialog({
  kind,
  onClose,
}: {
  kind: ConnectorKind | null;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<Mode>("auth");
  const [secret, setSecret] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [grokLoginUrl, setGrokLoginUrl] = useState<string | null>(null);
  const [gitUrl, setGitUrl] = useState("");
  const [gitRepos, setGitRepos] = useState<GitRepoHit[]>([]);
  const [gitQuery, setGitQuery] = useState("");

  const rec = useHub((s) => s.connectors.find((c) => c.id === kind));
  const ingestText = useHub((s) => s.ingestText);
  const ingestGitRepo = useHub((s) => s.ingestGitRepo);
  const connect = useHub((s) => s.connect);

  useEffect(() => {
    if (!kind) return;
    setMode(kind === "folder" ? "import" : "auth");
    setSecret("");
    setNotes("");
    setClientId(savedClientId(kind));
    setClientSecret("");
    setGrokLoginUrl(null);
    setGitUrl("");
    setGitRepos([]);
    setGitQuery("");
  }, [kind]);

  if (!kind) return null;
  const source: ConnectorKind = kind;
  const meta = CARD_META[source];
  const hint = source !== "folder" ? maskedHint(source) : null;
  const oauth = isOAuth(source);
  const oauthLabel = oauth ? OAUTH_PROVIDERS[source].label : "provider";

  async function ingestFiles(files: File[], sourceType?: SourceType) {
    if (source === "git") {
      await ingestGitDrops(files);
      return;
    }
    let added = 0;
    for (const file of files) {
      const content = await file.text();
      const res = ingestText({
        name: file.name,
        content,
        connectorId: source,
        sourceType,
      });
      if (!res.ok) toast.error(`${file.name}: ${res.error}`);
      else added += res.chunks;
    }
    if (added > 0) {
      toast.success(`Indexed ${added} chunks`);
      if (source !== "folder") connect(source);
      onClose();
    }
  }

  function ingestSample() {
    const samples: Partial<Record<ConnectorKind, { name: string; content: string; sourceType: SourceType }>> = {
      slack: { name: "sample_slack.json", content: SAMPLE_SLACK, sourceType: "slack" },
      zoom: { name: "zoom_q1_review.txt", content: SAMPLE_ZOOM_MINUTES, sourceType: "zoom" },
      gmeet: { name: "gmeet_search_sync.md", content: SAMPLE_GMEET_RECAP, sourceType: "gmeet" },
      teams: {
        name: "teams_engineering_standup.txt",
        content: SAMPLE_TEAMS_STANDUP,
        sourceType: "teams",
      },
    };
    const sample = samples[source];
    if (!sample) return;
    const res = ingestText({
      name: sample.name,
      content: sample.content,
      connectorId: source,
      sourceType: sample.sourceType,
    });
    if (res.ok) {
      connect(source);
      toast.success(`Indexed ${res.chunks} sample chunks`);
      onClose();
    } else toast.error(res.error);
  }

  async function ingestGitDrops(files: File[]) {
    const collected: { path: string; content: string }[] = [];
    for (const file of files) {
      if (file.name.toLowerCase().endsWith(".zip")) {
        const buf = await file.arrayBuffer();
        collected.push(...filesFromZipBuffer(buf));
      } else {
        collected.push({ path: file.name, content: await file.text() });
      }
    }
    if (collected.length === 0) {
      toast.error("No indexable source files in that drop.");
      return;
    }
    const res = ingestGitRepo({
      owner: "local",
      name: files[0]?.name.replace(/\.(zip|tgz)$/i, "") || "project",
      url: `local://${files[0]?.name ?? "project"}`,
      files: collected,
      origin: "upload",
    });
    if (!res.ok) {
      toast.error(res.error);
      return;
    }
    connect("git");
    toast.success(`Indexed ${res.chunks} git chunks`);
    onClose();
  }

  async function loadGitHubRepos(token: string, query = "") {
    const listed = await listGithubRepos({ data: { accessToken: token, query } });
    if (!listed.ok) {
      toast.error(listed.error);
      return;
    }
    setGitRepos(listed.repos);
    if (listed.repos.length === 0) {
      toast.message("No GitHub repos visible. Paste a git URL as a last resort.");
    }
  }

  async function indexGitHubRepo(hit: GitRepoHit) {
    setBusy(true);
    try {
      const token = accessTokenFor("git") ?? undefined;
      const fetched = await fetchGitRepo({
        data: { owner: hit.owner, name: hit.name, url: hit.url, accessToken: token },
      });
      if (!fetched.ok) {
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
      });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      connect("git", undefined, rec?.authMode === "oauth" ? "oauth" : "token");
      toast.success(`Indexed ${hit.fullName} · ${res.chunks} chunks`);
      onClose();
    } finally {
      setBusy(false);
    }
  }

  async function indexGitUrl() {
    const value = gitUrl.trim();
    if (!value) {
      toast.error("Paste a git URL first.");
      return;
    }
    setBusy(true);
    try {
      const token = accessTokenFor("git") ?? undefined;
      const fetched = await fetchGitRepo({ data: { url: value, accessToken: token } });
      if (!fetched.ok) {
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
      });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      connect("git", token, token ? (rec?.authMode === "oauth" ? "oauth" : "token") : undefined);
      toast.success(`Indexed ${fetched.owner}/${fetched.name} · ${res.chunks} chunks`);
      onClose();
    } finally {
      setBusy(false);
    }
  }

  async function runOAuth() {
    if (!isOAuth(source)) return;
    const id = clientId.trim() || savedClientId(source);
    if (!id) {
      toast.error("Paste your OAuth client ID first — or use an API token.");
      return;
    }
    setBusy(true);
    try {
      saveClientApp(source, id, clientSecret);
      const pending = await beginOAuth({ kind: source, clientId: id, clientSecret });
      const code = await waitForOAuthCode(pending.state);
      const exchanged = await exchangeOAuthCode({
        data: {
          kind: source,
          code,
          verifier: pending.verifier,
          clientId: id,
          clientSecret: clientSecret.trim() || undefined,
          redirectUri: redirectUri(),
        },
      });
      clearPendingOAuth();
      if (!exchanged.ok) {
        toast.error(exchanged.error);
        return;
      }
      saveOAuth(source, {
        ...exchanged.tokens,
        clientId: id,
        clientSecret: clientSecret.trim() || undefined,
      });
      connect(source, undefined, "oauth");
      toast.success(`Signed in with ${OAUTH_PROVIDERS[source].label}`);
      await runTokenSync(exchanged.tokens.accessToken, "oauth");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Sign-in failed");
    } finally {
      setBusy(false);
    }
  }

  async function runTokenSync(token: string, authMode: "oauth" | "token") {
    if (source === "folder" || source === "whatsapp") return;
    setBusy(true);
    try {
      if (source === "git") {
        connect(source, token, authMode);
        await loadGitHubRepos(token);
        toast.message("GitHub connected. Pick a repo, or paste a git URL only if lookup fails.");
        return;
      }
      const res = await syncRemoteSource({
        data: { kind: source, accessToken: token },
      });
      if (!res.ok) {
        toast.error(res.error);
        connect(source, token, authMode);
        return;
      }
      if (res.meetings.length === 0) {
        connect(source, token, authMode);
        toast.message(res.note ?? "Connected. Import an export to add minutes.");
        onClose();
        return;
      }
      const { chunks, files } = ingestRemoteMeetings(source, res.meetings, authMode);
      toast.success(`Synced ${files} meetings · ${chunks} chunks`);
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Sync failed");
    } finally {
      setBusy(false);
    }
  }

  async function saveAndSyncToken() {
    const token = secret.trim();
    if (!token) {
      toast.error("Paste a token first.");
      return;
    }
    connect(source, token, "token");
    setSecret("");
    await runTokenSync(token, "token");
  }

  async function runGrokSync() {
    setBusy(true);
    setGrokLoginUrl(null);
    try {
      const res = source === "teams" ? await syncGrokTeams() : await syncGrokGoogleMeet();
      if (!res.ok) {
        if (res.loginRequired) {
          setGrokLoginUrl(res.loginUrl ?? null);
          if (res.loginUrl) {
            redirectToLoginIfRequired({
              ok: false,
              data: null,
              loginRequired: true,
              loginUrl: res.loginUrl,
            });
          } else toast.message("Continue with Grok to load your calendar.");
          return;
        }
        if (res.pending) {
          toast.message("Waiting for Grok to finish connecting…");
          return;
        }
        if (res.notConnected) {
          toast.message(
            source === "teams"
              ? "Connect Microsoft Teams in Grok, then sync again."
              : "Connect Google Calendar in Grok, then sync again.",
          );
          return;
        }
        toast.error(res.error);
        return;
      }
      if (res.meetings.length === 0) {
        connect(source, undefined, "grok");
        toast.message(res.note ?? "Connected, nothing new to index.");
        return;
      }
      const { chunks, files } = ingestRemoteMeetings(source, res.meetings, "grok");
      connect(source, undefined, "grok");
      toast.success(`Synced ${files} meetings · ${chunks} chunks`);
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Grok sync failed");
    } finally {
      setBusy(false);
    }
  }

  const sourceType: SourceType | undefined =
    kind === "slack"
      ? "slack"
      : kind === "whatsapp"
        ? "whatsapp"
        : kind === "readai"
          ? "readai"
          : kind === "zoom"
            ? "zoom"
            : kind === "gmeet"
              ? "gmeet"
              : kind === "teams"
                ? "teams"
                : kind === "git"
                  ? "git"
                  : undefined;

  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o) {
          setSecret("");
          setNotes("");
          onClose();
        }
      }}
    >
      <DialogContent
        className="w-[min(92vw,540px)]"
        title={CONNECTOR_LABELS[kind]}
        description="Local-only. Sign in when the provider allows it, or paste a token. Credentials stay on this device and are never shown again."
      >
        {kind !== "folder" && (
          <div className="mb-4 grid grid-cols-3 gap-1 rounded-md bg-elevated p-1">
            {(["auth", "token", "import"] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                className={cn(
                  "h-9 rounded-sm text-xs font-medium capitalize",
                  mode === m ? "bg-surface text-fg" : "text-muted",
                )}
              >
                {m === "auth" ? "Sign in" : m === "token" ? "API token" : "Import"}
              </button>
            ))}
          </div>
        )}

        {mode === "auth" && kind !== "folder" && (
          <div className="flex flex-col gap-3">
            {oauth && (
              <>
                <p className="text-sm text-muted">
                  Register this redirect URI on your {oauthLabel} app, then sign in.
                </p>
                <code className="block overflow-x-auto rounded-sm bg-elevated px-2 py-2 font-mono text-[11px] text-subtle">
                  {typeof window !== "undefined" ? redirectUri() : "/oauth/callback"}
                </code>
                <div>
                  <Label htmlFor="cid">OAuth client ID</Label>
                  <Input
                    id="cid"
                    className="mt-1.5"
                    autoComplete="off"
                    value={clientId}
                    onChange={(e) => setClientId(e.target.value)}
                    placeholder="From the provider developer console"
                  />
                </div>
                <div>
                  <Label htmlFor="csec">Client secret (if required)</Label>
                  <Input
                    id="csec"
                    className="mt-1.5"
                    type="password"
                    autoComplete="off"
                    value={clientSecret}
                    onChange={(e) => setClientSecret(e.target.value)}
                    placeholder="Zoom and some Slack apps need this"
                  />
                </div>
                <Button disabled={busy} onClick={() => void runOAuth()}>
                  {busy ? <Loader2 className="animate-spin" /> : null}
                  Sign in with {oauthLabel}
                </Button>
              </>
            )}

            {(kind === "gmeet" || kind === "teams") && (
              <div className="rounded-md bg-elevated p-3">
                <p className="text-sm text-fg">Or use your Grok connector</p>
                <p className="mt-1 text-xs text-muted">
                  {kind === "gmeet"
                    ? "Reads Google Calendar events that have a Meet link."
                    : "Reads Teams / Outlook meetings the Grok connector can see."}
                </p>
                <Button
                  className="mt-2"
                  variant="secondary"
                  size="sm"
                  disabled={busy}
                  onClick={() => void runGrokSync()}
                >
                  {busy ? <Loader2 className="animate-spin" /> : null}
                  {kind === "gmeet" ? "Sync Google Calendar" : "Sync Teams via Grok"}
                </Button>
                {grokLoginUrl && (
                  <Button
                    className="mt-2"
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      redirectToLoginIfRequired({
                        ok: false,
                        data: null,
                        loginRequired: true,
                        loginUrl: grokLoginUrl,
                      })
                    }
                  >
                    Continue with Grok
                  </Button>
                )}
              </div>
            )}

            {kind === "git" && (
              <p className="text-sm text-muted">
                GitHub is how the hub reads the project Claude Code is on. Paste a git URL only
                if that lookup cannot see the repo.
              </p>
            )}

            {kind === "readai" && (
              <p className="text-sm text-muted">
                Read AI uses an API key. Switch to API token, or paste notes under Import.
              </p>
            )}
            {kind === "whatsapp" && (
              <p className="text-sm text-muted">
                WhatsApp has no user OAuth for personal chats. Paste a Cloud API token or import an export.
              </p>
            )}

            {rec?.hasSecret && (
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => {
                  const token = accessTokenFor(kind);
                  if (!token) {
                    toast.error("No saved token. Sign in or paste one.");
                    return;
                  }
                  void runTokenSync(token, oauthBundle(kind) ? "oauth" : "token");
                }}
              >
                {kind === "git" ? "List GitHub repos" : "Sync now"}
              </Button>
            )}

            {kind === "git" && gitRepos.length > 0 && (
              <GitRepoList repos={gitRepos} busy={busy} onPick={(r) => void indexGitHubRepo(r)} />
            )}

            {kind === "git" && (
              <LastResortGitUrl
                value={gitUrl}
                onChange={setGitUrl}
                busy={busy}
                onIndex={() => void indexGitUrl()}
              />
            )}
          </div>
        )}

        {mode === "token" && kind !== "folder" && (
          <div>
            <Label htmlFor="secret">{meta.tokenLabel}</Label>
            <Input
              id="secret"
              className="mt-1.5"
              type="password"
              autoComplete="off"
              placeholder={hint ?? meta.tokenHint}
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
            />
            <div className="mt-2 flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="secondary"
                disabled={busy}
                onClick={() => {
                  connect(kind, secret, "token");
                  setSecret("");
                  toast.success("Credential saved on this device");
                }}
              >
                Save token
              </Button>
              {kind !== "whatsapp" && (
                <Button size="sm" disabled={busy || !secret.trim()} onClick={() => void saveAndSyncToken()}>
                  {busy ? <Loader2 className="animate-spin" /> : null}
                  Save and sync
                </Button>
              )}
            </div>
            {rec?.hasSecret && (
              <p className="mt-2 font-mono text-[11px] text-subtle">Saved {hint}</p>
            )}
            {kind === "git" && gitRepos.length > 0 && (
              <GitRepoList
                repos={gitRepos.filter((r) =>
                  gitQuery
                    ? `${r.fullName} ${r.description}`.toLowerCase().includes(gitQuery.toLowerCase())
                    : true,
                )}
                busy={busy}
                onPick={(r) => void indexGitHubRepo(r)}
              />
            )}
            {kind === "git" && (
              <div className="mt-4">
                <Label htmlFor="git-filter">Filter repos</Label>
                <Input
                  id="git-filter"
                  className="mt-1.5"
                  value={gitQuery}
                  onChange={(e) => setGitQuery(e.target.value)}
                  placeholder="Search by name"
                />
                <LastResortGitUrl
                  value={gitUrl}
                  onChange={setGitUrl}
                  busy={busy}
                  onIndex={() => void indexGitUrl()}
                />
              </div>
            )}
          </div>
        )}

        {(mode === "import" || kind === "folder") && (
          <div>
            {kind === "readai" && (
              <div className="mb-4">
                <Label htmlFor="notes">Paste notes</Label>
                <Textarea
                  id="notes"
                  className="mt-1.5"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="[2025-03-10 09:02] Alice: …"
                />
                <Button
                  className="mt-2"
                  size="sm"
                  disabled={!notes.trim()}
                  onClick={() => {
                    const res = ingestText({
                      name: `readai-${Date.now()}.txt`,
                      content: notes,
                      connectorId: "readai",
                      sourceType: "readai",
                    });
                    if (res.ok) {
                      toast.success(`Indexed ${res.chunks} chunks`);
                      setNotes("");
                      onClose();
                    } else toast.error(res.error);
                  }}
                >
                  Ingest notes
                </Button>
              </div>
            )}
            <DropZone
              label={`Drop ${meta.ingestHint}`}
              hint="Parsed on this device"
              accept={meta.accept}
              onFiles={(files) => void ingestFiles(files, sourceType)}
            />
            {(kind === "slack" || kind === "zoom" || kind === "gmeet" || kind === "teams") && (
              <Button className="mt-3 w-full" variant="ghost" size="sm" onClick={ingestSample}>
                Load sample {CONNECTOR_LABELS[kind]} minutes
              </Button>
            )}
            {kind === "git" && (
              <Button
                className="mt-3 w-full"
                variant="ghost"
                size="sm"
                onClick={() => {
                  const res = ingestGitRepo({
                    owner: "acme",
                    name: "knowledge-hub",
                    url: "https://github.com/acme/knowledge-hub",
                    files: SAMPLE_GIT_FILES,
                    origin: "upload",
                  });
                  if (res.ok) {
                    connect("git");
                    toast.success(`Indexed ${res.chunks} sample git chunks`);
                    onClose();
                  } else toast.error(res.error);
                }}
              >
                Load sample knowledge-hub repo
              </Button>
            )}
            {kind === "folder" && (
              <p className="mt-3 text-xs text-subtle">
                Meetings: <code className="font-mono">[timestamp] Speaker: text</code>
                <br />
                Sessions: <code className="font-mono">[USER iso-ts]</code> /{" "}
                <code className="font-mono">[ASSISTANT iso-ts]</code>
                <br />
                Video: Zoom / Meet / Teams VTT or labeled minutes
              </p>
            )}
            {kind === "git" && (
              <LastResortGitUrl
                value={gitUrl}
                onChange={setGitUrl}
                busy={busy}
                onIndex={() => void indexGitUrl()}
              />
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function GitRepoList({
  repos,
  busy,
  onPick,
}: {
  repos: GitRepoHit[];
  busy: boolean;
  onPick: (repo: GitRepoHit) => void;
}) {
  if (repos.length === 0) return null;
  return (
    <ul className="flex max-h-48 flex-col gap-1 overflow-y-auto">
      {repos.slice(0, 12).map((r) => (
        <li key={r.fullName}>
          <button
            type="button"
            disabled={busy}
            onClick={() => onPick(r)}
            className="flex min-h-11 w-full items-center justify-between gap-2 rounded-sm bg-elevated px-3 py-2 text-left"
          >
            <span className="font-mono text-xs text-fg">{r.fullName}</span>
            <span className="truncate text-[11px] text-muted">{r.private ? "private" : "public"}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function LastResortGitUrl({
  value,
  onChange,
  busy,
  onIndex,
}: {
  value: string;
  onChange: (v: string) => void;
  busy: boolean;
  onIndex: () => void;
}) {
  return (
    <div className="mt-3 rounded-md bg-elevated p-3">
      <Label htmlFor="git-url-last">Git URL — last resort</Label>
      <p className="mt-1 text-xs text-muted">
        Only if GitHub / Claude Code cannot reach the project.
      </p>
      <Input
        id="git-url-last"
        className="mt-2"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="https://github.com/org/project"
        autoComplete="off"
      />
      <Button className="mt-2" size="sm" variant="secondary" disabled={busy || !value.trim()} onClick={onIndex}>
        {busy ? <Loader2 className="animate-spin" /> : null}
        Index URL
      </Button>
    </div>
  );
}


