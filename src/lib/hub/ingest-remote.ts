import { useHub } from "./store.ts";
import type { ConnectorAuthMode, ConnectorKind, RemoteMeeting, SourceType } from "./types.ts";

const KIND_SOURCE: Record<string, SourceType> = {
  zoom: "zoom",
  gmeet: "gmeet",
  teams: "teams",
  slack: "slack",
  readai: "readai",
};

export function ingestRemoteMeetings(
  kind: ConnectorKind,
  meetings: RemoteMeeting[],
  authMode: ConnectorAuthMode,
): { chunks: number; files: number } {
  let chunks = 0;
  let files = 0;
  const sourceType = KIND_SOURCE[kind] ?? "meeting";
  for (const m of meetings) {
    const content = [
      `Meeting: ${m.title}`,
      `Date: ${m.startedAt}`,
      m.attendees.length ? `Attendees: ${m.attendees.join(", ")}` : "",
      m.summary ? `Summary:\n${m.summary}` : "",
      m.decisions.length ? `Decisions:\n${m.decisions.map((d) => `- ${d}`).join("\n")}` : "",
      m.actionItems.length
        ? `Action items:\n${m.actionItems.map((a) => `- ${a.owner}: ${a.text}`).join("\n")}`
        : "",
      m.transcript ? `\n${m.transcript}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    const res = useHub.getState().ingestText({
      name: m.sourceFile,
      content,
      connectorId: kind,
      sourceType,
    });
    if (res.ok) {
      chunks += res.chunks;
      files += 1;
    }
  }
  useHub.getState().markSynced(kind, authMode);
  return { chunks, files };
}
