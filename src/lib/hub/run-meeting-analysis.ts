/**
 * Client-side helper that drives post-meeting analysis.
 * Reads the active AI provider config from localStorage, gathers optional
 * code context from a linked repo, calls the server function, then patches
 * the meeting record in the store.
 */
import { analyzeMeeting } from "./analyze-meeting.ts";
import { loadAiProviders, resolveCallConfig } from "./ai-providers.ts";
import { useHub } from "./store.ts";
import type { MeetingRecord, RetrievedChunk } from "./types.ts";

function codeContextFor(meeting: MeetingRecord): RetrievedChunk[] {
  const state = useHub.getState();
  if (!meeting.linkedRepoId) return [];
  const repo = state.repos.find((r) => r.id === meeting.linkedRepoId);
  if (!repo) return [];
  return state.chunks
    .filter((c) => c.documentId === repo.documentId && c.sourceType === "git")
    .slice(0, 6)
    .map((c) => ({
      text: c.text,
      sourceType: c.sourceType,
      timestamp: c.timestamp,
      sourceFile: c.sourceFile,
      score: 1,
      id: c.id,
      chunkKind: c.chunkKind,
    }));
}

function transcriptFor(meeting: MeetingRecord): string {
  const state = useHub.getState();
  return state.chunks
    .filter((c) => c.documentId === meeting.documentId)
    .slice(0, 40)
    .map((c) => c.text)
    .join("\n");
}

/**
 * Run analysis for one meeting. Safe to call multiple times; it updates
 * analysisStatus as it progresses.
 */
export async function runMeetingAnalysis(meetingId: string): Promise<void> {
  const state = useHub.getState();
  const meeting = state.meetings.find((m) => m.id === meetingId);
  if (!meeting) return;

  state.patchMeeting(meetingId, {
    analysisStatus: "pending",
    analysisError: null,
  });

  const aiState = loadAiProviders();
  const ai = resolveCallConfig(aiState);
  const codeContext = codeContextFor(meeting);
  const transcript = transcriptFor(meeting);

  try {
    const res = await analyzeMeeting({
      data: {
        meeting: {
          id: meeting.id,
          title: meeting.title,
          startedAt: meeting.startedAt,
          attendees: meeting.attendees,
          summary: meeting.summary,
          decisions: meeting.decisions,
          actionItems: meeting.actionItems,
          sourceFile: meeting.sourceFile,
          platform: meeting.platform,
        },
        transcript,
        codeContext,
        ai,
      },
    });

    if (res.ok) {
      useHub.getState().patchMeeting(meetingId, {
        analysisStatus: "done",
        analysis: res.analysis,
        analysisError: null,
      });
    } else {
      useHub.getState().patchMeeting(meetingId, {
        analysisStatus: "failed",
        analysisError: res.error,
      });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Analysis failed";
    useHub.getState().patchMeeting(meetingId, {
      analysisStatus: "failed",
      analysisError: msg.slice(0, 300),
    });
  } finally {
    useHub.getState().clearPendingAnalysis(meetingId);
  }
}

/**
 * Drain the pending-analysis queue. Call from a React effect in the shell
 * so newly ingested meetings are analysed automatically.
 */
export async function drainPendingAnalyses(): Promise<void> {
  const ids = [...useHub.getState().pendingAnalysisIds];
  for (const id of ids) {
    await runMeetingAnalysis(id);
  }
}
