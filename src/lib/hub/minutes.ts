import { randomId } from "./ids.ts";
import type { ActionItem, ConnectorKind, MeetingRecord, ParsedChunk, SourceType } from "./types.ts";

const ACTION_LINE =
  /^\s*(?:[-*]|\d+[.)]|\[\s?[x ]\s?\])\s*(?:(?<owner>[A-Za-z][\w .'-]{1,40})\s*[:—–-]\s*)?(?<text>.+)$/;

function linesOf(content: string): string[] {
  return content.split(/\r?\n/);
}

function section(content: string, names: string[]): string {
  const re = new RegExp(
    `(?:^|\\n)#{0,3}\\s*(?:${names.join("|")})\\s*:?\\s*\\n([\\s\\S]*?)(?=\\n#{0,3}\\s*[A-Z][A-Za-z ]{2,40}\\s*:?\\s*\\n|$)`,
    "i",
  );
  return content.match(re)?.[1]?.trim() ?? "";
}

function bullets(block: string): string[] {
  return block
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*(?:[-*]|\d+[.)]|\[\s?[x ]\s?\])\s*/, "").trim())
    .filter((l) => l.length > 2);
}

function parseActions(block: string): ActionItem[] {
  const items: ActionItem[] = [];
  for (const raw of block.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(ACTION_LINE);
    if (!m) continue;
    const text = (m.groups?.text ?? line).trim();
    if (!text) continue;
    items.push({ owner: (m.groups?.owner ?? "unassigned").trim(), text });
  }
  return items;
}

function firstMatch(content: string, patterns: RegExp[]): string {
  for (const p of patterns) {
    const m = content.match(p);
    if (m?.[1]) return m[1].trim();
  }
  return "";
}

export function inferPlatform(sourceType: SourceType): MeetingRecord["platform"] {
  if (sourceType === "zoom" || sourceType === "gmeet" || sourceType === "teams" || sourceType === "readai") {
    return sourceType;
  }
  return "meeting";
}

export function extractMinutes(opts: {
  content: string;
  sourceFile: string;
  sourceType: SourceType;
  connectorId: ConnectorKind;
  documentId: string;
  chunks: ParsedChunk[];
}): MeetingRecord | null {
  const { content, sourceFile, sourceType, connectorId, documentId, chunks } = opts;
  if (
    sourceType !== "zoom" &&
    sourceType !== "gmeet" &&
    sourceType !== "teams" &&
    sourceType !== "readai" &&
    sourceType !== "meeting"
  ) {
    return null;
  }

  const title =
    firstMatch(content, [
      /^#{1,3}\s+(.+)$/m,
      /^(?:meeting|topic|title)\s*:\s*(.+)$/im,
      /^Meeting in (.+)$/m,
    ]) || sourceFile.replace(/\.[a-z0-9]+$/i, "").replace(/[_-]+/g, " ");

  const startedAt =
    firstMatch(content, [
      /^(?:date|started|start|when)\s*:\s*(.+)$/im,
      /\b(20\d{2}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?)?)/,
    ]) ||
    chunks[0]?.timestamp ||
    new Date().toISOString();

  const attendeeBlock = section(content, [
    "attendees",
    "participants",
    "present",
    "who attended",
  ]);
  let attendees = attendeeBlock
    ? attendeeBlock
        .split(/[,;\n]/)
        .map((s) => s.replace(/^[-*]\s*/, "").trim())
        .filter((s) => s.length > 1 && s.length < 60)
    : [];
  if (attendees.length === 0) {
    const speakers = new Set<string>();
    for (const c of chunks) {
      const who = c.text.split(":")[0]?.trim();
      if (who && who.length < 40 && !/^(summary|decision|action)/i.test(who)) speakers.add(who);
    }
    attendees = [...speakers].slice(0, 12);
  }

  const summaryBlock =
    section(content, ["summary", "overview", "recap", "notes", "minutes"]) ||
    chunks
      .filter((c) => (c.chunkKind ?? "turn") === "turn")
      .slice(0, 4)
      .map((c) => c.text)
      .join(" ");

  const decisions = bullets(section(content, ["decisions", "decision", "agreed", "we decided"]));
  const actionItems = parseActions(
    section(content, ["action items", "actions", "action item", "next steps", "todos", "todo"]),
  );

  const hasStructure = Boolean(
    summaryBlock.length > 40 || decisions.length > 0 || actionItems.length > 0,
  );
  if (!hasStructure && chunks.length === 0) return null;

  return {
    id: randomId("mtg"),
    title: title.slice(0, 120),
    platform: inferPlatform(sourceType),
    connectorId,
    startedAt,
    attendees,
    summary: summaryBlock.slice(0, 1200),
    decisions: decisions.slice(0, 12),
    actionItems: actionItems.slice(0, 16),
    documentId,
    sourceFile,
  };
}

export function minutesToChunks(meeting: MeetingRecord, sourceType: SourceType): ParsedChunk[] {
  const chunks: ParsedChunk[] = [];
  const file = meeting.sourceFile;
  const ts = meeting.startedAt;
  if (meeting.summary) {
    chunks.push({
      text: `Minutes · ${meeting.title}. ${meeting.summary}`,
      sourceType,
      timestamp: ts,
      sourceFile: file,
      chunkKind: "summary",
    });
  }
  if (meeting.attendees.length) {
    chunks.push({
      text: `Attendees for ${meeting.title}: ${meeting.attendees.join(", ")}`,
      sourceType,
      timestamp: ts,
      sourceFile: file,
      chunkKind: "minutes",
    });
  }
  meeting.decisions.forEach((d, i) => {
    chunks.push({
      text: `Decision (${meeting.title}): ${d}`,
      sourceType,
      timestamp: `${ts}#d${i + 1}`,
      sourceFile: file,
      chunkKind: "decision",
    });
  });
  meeting.actionItems.forEach((a, i) => {
    chunks.push({
      text: `Action item (${meeting.title}): ${a.owner} — ${a.text}`,
      sourceType,
      timestamp: `${ts}#a${i + 1}`,
      sourceFile: file,
      chunkKind: "action",
    });
  });
  return chunks;
}

export function meetingFromRemote(input: {
  title: string;
  startedAt: string;
  attendees?: string[];
  summary?: string;
  decisions?: string[];
  actionItems?: ActionItem[];
  transcript?: string;
  sourceType: SourceType;
  connectorId: ConnectorKind;
  sourceFile: string;
  documentId: string;
}): { meeting: MeetingRecord; extraContent: string } {
  const extra = [
    `Meeting: ${input.title}`,
    `Date: ${input.startedAt}`,
    input.attendees?.length ? `Attendees: ${input.attendees.join(", ")}` : "",
    input.summary ? `Summary:\n${input.summary}` : "",
    input.decisions?.length ? `Decisions:\n${input.decisions.map((d) => `- ${d}`).join("\n")}` : "",
    input.actionItems?.length
      ? `Action items:\n${input.actionItems.map((a) => `- ${a.owner}: ${a.text}`).join("\n")}`
      : "",
    input.transcript ? `\n${input.transcript}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const meeting: MeetingRecord = {
    id: randomId("mtg"),
    title: input.title,
    platform: inferPlatform(input.sourceType),
    connectorId: input.connectorId,
    startedAt: input.startedAt,
    attendees: input.attendees ?? [],
    summary: (input.summary ?? "").slice(0, 1200),
    decisions: input.decisions ?? [],
    actionItems: input.actionItems ?? [],
    documentId: input.documentId,
    sourceFile: input.sourceFile,
  };
  return { meeting, extraContent: extra };
}
