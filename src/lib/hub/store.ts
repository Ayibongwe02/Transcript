import { useEffect } from "react";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { chunkGitFiles } from "./git.ts";
import { attachMinutesChunks, makeChunkId, parseFile } from "./parsers.ts";
import { extractMinutes } from "./minutes.ts";
import {
  SAMPLE_GMEET_RECAP,
  SAMPLE_GIT_FILES,
  SAMPLE_MEETING,
  SAMPLE_SESSION,
  SAMPLE_TEAMS_STANDUP,
  SAMPLE_ZOOM_MINUTES,
} from "./sample-data.ts";
import { clearSecret, hasOAuth, hasSecret, saveSecret } from "./secrets.ts";
import type {
  AnalysisStatus,
  Chunk,
  ConnectorAuthMode,
  ConnectorKind,
  ConnectorRecord,
  DocumentRecord,
  GitFile,
  MeetingRecord,
  MeetingRepoStatus,
  QueryRecord,
  RepoOrigin,
  RepoRecord,
  SourceType,
} from "./types.ts";
import { CONNECTOR_KINDS, MAX_CHUNKS } from "./types.ts";
import { randomId } from "./ids.ts";

type MeetingPatch = Partial<
  Pick<
    MeetingRecord,
    | "linkedRepoId"
    | "repoStatus"
    | "repoHint"
    | "repoCandidates"
    | "endedAt"
    | "analysisStatus"
    | "analysis"
    | "analysisError"
  >
>;

type HubState = {
  hydrated: boolean;
  seeded: boolean;
  connectors: ConnectorRecord[];
  documents: DocumentRecord[];
  chunks: Chunk[];
  queries: QueryRecord[];
  meetings: MeetingRecord[];
  repos: RepoRecord[];
  /** IDs of meetings that just landed and still need auto-analysis. */
  pendingAnalysisIds: string[];
  setHydrated: () => void;
  seedIfEmpty: () => void;
  ingestText: (opts: {
    name: string;
    content: string;
    connectorId: ConnectorKind;
    sourceType?: SourceType;
  }) => { ok: true; chunks: number; documentId: string; meetingId?: string } | { ok: false; error: string };
  ingestGitRepo: (opts: {
    owner: string;
    name: string;
    url: string;
    defaultBranch?: string;
    files: GitFile[];
    origin: RepoOrigin;
    meetingId?: string;
  }) => { ok: true; chunks: number; repoId: string; documentId: string } | { ok: false; error: string };
  removeDocument: (id: string) => void;
  connect: (kind: ConnectorKind, secret?: string, authMode?: ConnectorAuthMode) => void;
  revoke: (kind: ConnectorKind) => void;
  markSynced: (kind: ConnectorKind, authMode?: ConnectorAuthMode) => void;
  rememberQuery: (q: QueryRecord) => void;
  clearQueries: () => void;
  patchMeeting: (meetingId: string, patch: MeetingPatch) => void;
  /** Mark meeting ended and queue it for (re-)analysis. */
  markMeetingEnded: (meetingId: string) => void;
  /** Queue a meeting for analysis (or re-analysis). */
  queueAnalysis: (meetingId: string) => void;
  /** Clear a meeting from the pending queue once analysis finishes. */
  clearPendingAnalysis: (meetingId: string) => void;
};

function defaultConnectors(): ConnectorRecord[] {
  return CONNECTOR_KINDS.map((id) => ({
    id,
    status: id === "folder" ? "connected" : "disconnected",
    lastSyncAt: null,
    hasSecret: false,
    authMode: "none",
  }));
}

function mergeConnectors(existing: ConnectorRecord[] | undefined): ConnectorRecord[] {
  const map = new Map((existing ?? []).map((c) => [c.id, c]));
  return CONNECTOR_KINDS.map((id) => {
    const prev = map.get(id);
    if (!prev) {
      return {
        id,
        status: id === "folder" ? "connected" : "disconnected",
        lastSyncAt: null,
        hasSecret: false,
        authMode: "none" as const,
      };
    }
    return {
      id,
      status: prev.status,
      lastSyncAt: prev.lastSyncAt ?? null,
      hasSecret: prev.hasSecret,
      authMode: prev.authMode ?? "none",
    };
  });
}

export const useHub = create<HubState>()(
  persist(
    (set, get) => ({
      hydrated: false,
      seeded: false,
      connectors: defaultConnectors(),
      documents: [],
      chunks: [],
      queries: [],
      meetings: [],
      repos: [],
      pendingAnalysisIds: [],
      setHydrated: () => set({ hydrated: true }),
      seedIfEmpty: () => {
        if (get().seeded || get().chunks.length > 0) {
          set({
            seeded: true,
            hydrated: true,
            connectors: mergeConnectors(get().connectors),
            repos: get().repos ?? [],
          });
          return;
        }
        get().ingestText({
          name: "sample_meeting.txt",
          content: SAMPLE_MEETING,
          connectorId: "folder",
          sourceType: "meeting",
        });
        get().ingestText({
          name: "sample_session.log",
          content: SAMPLE_SESSION,
          connectorId: "folder",
          sourceType: "code_session",
        });
        get().ingestText({
          name: "zoom_q1_review.txt",
          content: SAMPLE_ZOOM_MINUTES,
          connectorId: "zoom",
          sourceType: "zoom",
        });
        get().ingestText({
          name: "gmeet_search_sync.md",
          content: SAMPLE_GMEET_RECAP,
          connectorId: "gmeet",
          sourceType: "gmeet",
        });
        get().ingestText({
          name: "teams_engineering_standup.txt",
          content: SAMPLE_TEAMS_STANDUP,
          connectorId: "teams",
          sourceType: "teams",
        });
        const gitRes = get().ingestGitRepo({
          owner: "acme",
          name: "knowledge-hub",
          url: "https://github.com/acme/knowledge-hub",
          defaultBranch: "main",
          files: SAMPLE_GIT_FILES,
          origin: "upload",
        });
        const zoomMeeting = get().meetings.find((m) => m.sourceFile === "zoom_q1_review.txt");
        if (gitRes.ok && zoomMeeting) {
          get().patchMeeting(zoomMeeting.id, {
            linkedRepoId: gitRes.repoId,
            repoStatus: "linked",
            repoHint: null,
            repoCandidates: [],
          });
        }
        set((state) => ({
          seeded: true,
          hydrated: true,
          connectors: mergeConnectors(state.connectors).map((c) =>
            c.id === "folder" ||
            c.id === "zoom" ||
            c.id === "gmeet" ||
            c.id === "teams" ||
            c.id === "git"
              ? { ...c, status: "connected", lastSyncAt: new Date().toISOString() }
              : c,
          ),
        }));
      },
      ingestText: ({ name, content, connectorId, sourceType }) => {
        const parsedTurns = parseFile(content, name, sourceType);
        const kind = sourceType ?? parsedTurns[0]?.sourceType ?? "meeting";
        const documentId = randomId("doc");
        const meeting = extractMinutes({
          content,
          sourceFile: name,
          sourceType: kind,
          connectorId,
          documentId,
          chunks: parsedTurns,
        });
        const parsed = attachMinutesChunks(parsedTurns, meeting, kind);
        if (parsed.length === 0) {
          return {
            ok: false as const,
            error: "No chunks found. Check the file format matches this source.",
          };
        }
        const now = new Date().toISOString();
        const existing = get().chunks;
        if (existing.length + parsed.length > MAX_CHUNKS) {
          return {
            ok: false as const,
            error: `Index would exceed ${MAX_CHUNKS} chunks. Remove something first.`,
          };
        }

        const newChunks: Chunk[] = parsed.map((p) => ({
          id: makeChunkId(p),
          text: p.text,
          sourceType: p.sourceType,
          timestamp: p.timestamp,
          sourceFile: p.sourceFile,
          documentId,
          connectorId,
          chunkKind: p.chunkKind ?? "turn",
        }));

        const byId = new Map(existing.map((c) => [c.id, c]));
        for (const c of newChunks) byId.set(c.id, c);

        const doc: DocumentRecord = {
          id: documentId,
          name,
          sourceType: kind,
          connectorId,
          ingestedAt: now,
          chunkCount: newChunks.length,
          bytes: content.length,
        };

        // Auto-queue analysis the moment a new meeting record lands.
        const meetingWithStatus: MeetingRecord | null = meeting
          ? {
              ...meeting,
              analysisStatus: "pending" as AnalysisStatus,
              analysis: null,
              analysisError: null,
            }
          : null;

        set((state) => ({
          chunks: [...byId.values()],
          documents: [
            ...state.documents.filter((d) => !(d.name === name && d.connectorId === connectorId)),
            doc,
          ],
          meetings: meetingWithStatus
            ? [
                ...state.meetings.filter(
                  (m) => !(m.sourceFile === name && m.connectorId === connectorId),
                ),
                meetingWithStatus,
              ]
            : state.meetings,
          pendingAnalysisIds: meetingWithStatus
            ? [
                ...state.pendingAnalysisIds.filter((id) => id !== meetingWithStatus.id),
                meetingWithStatus.id,
              ]
            : state.pendingAnalysisIds,
          connectors: mergeConnectors(state.connectors).map((c) =>
            c.id === connectorId ? { ...c, status: "connected", lastSyncAt: now } : c,
          ),
        }));
        return {
          ok: true as const,
          chunks: newChunks.length,
          documentId,
          meetingId: meetingWithStatus?.id,
        };
      },
      ingestGitRepo: ({ owner, name, url, defaultBranch, files, origin, meetingId }) => {
        const label = `${owner}/${name}`;
        const parsed = chunkGitFiles(files, label);
        if (parsed.length === 0) {
          return { ok: false as const, error: "No indexable source files in that repository." };
        }
        const existing = get().chunks;
        if (existing.length + parsed.length > MAX_CHUNKS) {
          return {
            ok: false as const,
            error: `Index would exceed ${MAX_CHUNKS} chunks. Remove something first.`,
          };
        }
        const now = new Date().toISOString();
        const prev = (get().repos ?? []).find(
          (r) => r.owner.toLowerCase() === owner.toLowerCase() && r.name.toLowerCase() === name.toLowerCase(),
        );
        const documentId = prev?.documentId ?? randomId("doc");
        const repoId = prev?.id ?? randomId("repo");
        const newChunks: Chunk[] = parsed.map((p) => ({
          id: makeChunkId(p),
          text: p.text,
          sourceType: "git",
          timestamp: p.timestamp,
          sourceFile: p.sourceFile,
          documentId,
          connectorId: "git",
          chunkKind: "code",
        }));
        const kept = existing.filter((c) => c.documentId !== documentId);
        const byId = new Map(kept.map((c) => [c.id, c]));
        for (const c of newChunks) byId.set(c.id, c);
        const bytes = files.reduce((n, f) => n + f.content.length, 0);
        const doc: DocumentRecord = {
          id: documentId,
          name: label,
          sourceType: "git",
          connectorId: "git",
          ingestedAt: now,
          chunkCount: newChunks.length,
          bytes,
        };
        const repo: RepoRecord = {
          id: repoId,
          owner,
          name,
          url,
          defaultBranch: defaultBranch ?? "main",
          documentId,
          indexedAt: now,
          fileCount: files.length,
          chunkCount: newChunks.length,
          origin,
        };
        set((state) => ({
          chunks: [...byId.values()],
          documents: [...state.documents.filter((d) => d.id !== documentId), doc],
          repos: [...(state.repos ?? []).filter((r) => r.id !== repoId), repo],
          meetings: state.meetings.map((m) =>
            meetingId && m.id === meetingId
              ? {
                  ...m,
                  linkedRepoId: repoId,
                  repoStatus: "linked" as MeetingRepoStatus,
                  repoHint: null,
                  repoCandidates: [],
                }
              : m,
          ),
          connectors: mergeConnectors(state.connectors).map((c) =>
            c.id === "git" ? { ...c, status: "connected", lastSyncAt: now } : c,
          ),
        }));
        return { ok: true as const, chunks: newChunks.length, repoId, documentId };
      },
      removeDocument: (id) => {
        set((state) => {
          const repo = (state.repos ?? []).find((r) => r.documentId === id);
          return {
            documents: state.documents.filter((d) => d.id !== id),
            chunks: state.chunks.filter((c) => c.documentId !== id),
            meetings: state.meetings
              .filter((m) => m.documentId !== id)
              .map((m) =>
                repo && m.linkedRepoId === repo.id
                  ? { ...m, linkedRepoId: null, repoStatus: "idle" as const, repoHint: null }
                  : m,
              ),
            repos: (state.repos ?? []).filter((r) => r.documentId !== id),
          };
        });
      },
      connect: (kind, secret, authMode) => {
        if (secret && secret.trim()) saveSecret(kind, secret);
        const mode: ConnectorAuthMode =
          authMode ?? (hasOAuth(kind) ? "oauth" : secret ? "token" : "none");
        set((state) => ({
          connectors: mergeConnectors(state.connectors).map((c) =>
            c.id === kind
              ? { ...c, status: "connected", hasSecret: hasSecret(kind), authMode: mode }
              : c,
          ),
        }));
      },
      revoke: (kind) => {
        clearSecret(kind);
        set((state) => {
          const removedRepoIds = new Set(
            (state.repos ?? []).filter((r) => kind === "git").map((r) => r.id),
          );
          return {
            connectors: mergeConnectors(state.connectors).map((c) =>
              c.id === kind
                ? {
                    ...c,
                    status: kind === "folder" ? "connected" : "disconnected",
                    hasSecret: false,
                    lastSyncAt: null,
                    authMode: "none",
                  }
                : c,
            ),
            documents: state.documents.filter((d) => d.connectorId !== kind),
            chunks: state.chunks.filter((c) => c.connectorId !== kind),
            meetings:
              kind === "git"
                ? state.meetings.map((m) =>
                    m.linkedRepoId && removedRepoIds.has(m.linkedRepoId)
                      ? { ...m, linkedRepoId: null, repoStatus: "idle" as const, repoHint: null }
                      : m,
                  )
                : state.meetings.filter((m) => m.connectorId !== kind),
            repos: kind === "git" ? [] : (state.repos ?? []),
          };
        });
      },
      markSynced: (kind, authMode) => {
        const now = new Date().toISOString();
        set((state) => ({
          connectors: mergeConnectors(state.connectors).map((c) =>
            c.id === kind
              ? {
                  ...c,
                  status: "connected",
                  lastSyncAt: now,
                  hasSecret: hasSecret(kind),
                  authMode: authMode ?? c.authMode,
                }
              : c,
          ),
        }));
      },
      rememberQuery: (q) => {
        set((state) => ({
          queries: [q, ...state.queries].slice(0, 20),
        }));
      },
      clearQueries: () => set({ queries: [] }),
      patchMeeting: (meetingId, patch) => {
        set((state) => ({
          meetings: state.meetings.map((m) => (m.id === meetingId ? { ...m, ...patch } : m)),
        }));
      },
      markMeetingEnded: (meetingId) => {
        const now = new Date().toISOString();
        set((state) => ({
          meetings: state.meetings.map((m) =>
            m.id === meetingId
              ? {
                  ...m,
                  endedAt: now,
                  analysisStatus: "pending" as AnalysisStatus,
                  analysisError: null,
                }
              : m,
          ),
          pendingAnalysisIds: [
            ...state.pendingAnalysisIds.filter((id) => id !== meetingId),
            meetingId,
          ],
        }));
      },
      queueAnalysis: (meetingId) => {
        set((state) => ({
          meetings: state.meetings.map((m) =>
            m.id === meetingId
              ? {
                  ...m,
                  analysisStatus: "pending" as AnalysisStatus,
                  analysisError: null,
                }
              : m,
          ),
          pendingAnalysisIds: [
            ...state.pendingAnalysisIds.filter((id) => id !== meetingId),
            meetingId,
          ],
        }));
      },
      clearPendingAnalysis: (meetingId) => {
        set((state) => ({
          pendingAnalysisIds: state.pendingAnalysisIds.filter((id) => id !== meetingId),
        }));
      },
    }),
    {
      name: "knowledge-hub.store.v5",
      skipHydration: true,
      partialize: (s) => ({
        seeded: s.seeded,
        connectors: s.connectors,
        documents: s.documents,
        chunks: s.chunks,
        queries: s.queries,
        meetings: s.meetings,
        repos: s.repos,
        // pendingAnalysisIds intentionally not persisted — re-queued on next open if needed
      }),
    },
  ),
);

export function useHydrateHub() {
  useEffect(() => {
    let cancelled = false;
    const finish = () => {
      if (cancelled) return;
      const secretSync = mergeConnectors(useHub.getState().connectors).map((c) => ({
        ...c,
        hasSecret: hasSecret(c.id),
      }));
      useHub.setState({
        connectors: secretSync,
        hydrated: true,
        repos: useHub.getState().repos ?? [],
        chunks: useHub.getState().chunks.map((ch) => ({
          ...ch,
          chunkKind: ch.chunkKind ?? "turn",
        })),
      });
      useHub.getState().seedIfEmpty();
    };
    try {
      void Promise.resolve(useHub.persist.rehydrate()).then(finish, finish);
    } catch {
      finish();
    }
    return () => {
      cancelled = true;
    };
  }, []);
}
