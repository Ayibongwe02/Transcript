import { chunkGitFiles } from "./git.ts";
import { chunkId } from "./ids.ts";
import { minutesToChunks } from "./minutes.ts";
import type { MeetingRecord, ParsedChunk, SourceType } from "./types.ts";
import { MAX_CHUNK_CHARS } from "./types.ts";

const MEETING_LINE =
  /^\[(?<ts>[^\]]+)\]\s+(?<speaker>[^:]+):\s*(?<body>.*)$/;

const SESSION_HEADER =
  /^\[(?<role>USER|ASSISTANT)\s+(?<ts>[^\]]+)\]\s*$/gm;

const WHATSAPP_BRACKET =
  /^\[(?<ts>\d{1,2}[/.]\d{1,2}[/.]\d{2,4},?\s+\d{1,2}:\d{2}(?::\d{2})?(?:\s*[AP]M)?)\]\s+(?<speaker>[^:]+):\s*(?<body>.*)$/i;

const WHATSAPP_DASH =
  /^(?<ts>\d{1,2}[/.]\d{1,2}[/.]\d{2,4},?\s+\d{1,2}:\d{2}(?::\d{2})?(?:\s*[AP]M)?)\s+-\s+(?<speaker>[^:]+):\s*(?<body>.*)$/i;

const READAI_CLOCK =
  /^(?:\[)?(?<ts>\d{1,2}:\d{2}(?::\d{2})?)(?:\])?\s+(?<speaker>[^:]+):\s*(?<body>.*)$/;

const SLACK_HEADER = /^(?<speaker>[A-Za-z][\w .'-]{0,40})\s+(?<ts>\d{1,2}:\d{2}\s*(?:AM|PM)?)\s*$/i;

const TEAMS_BRACKET =
  /^\[(?<ts>\d{1,2}:\d{2}(?:\s*[AP]M)?)\]\s+(?<speaker>[^:]+):\s*(?<body>.*)$/i;

const VTT_TIME = /^(?:(?<h>\d{2}):)?(?<m>\d{2}):(?<s>\d{2})[.,](?<ms>\d{3})\s*-->/;

function clip(text: string): string {
  const t = text.trim();
  if (t.length <= MAX_CHUNK_CHARS) return t;
  return t.slice(0, MAX_CHUNK_CHARS - 1) + "…";
}

function withIds(chunks: ParsedChunk[]): ParsedChunk[] {
  return chunks.map((c) => ({
    ...c,
    text: clip(c.text),
    chunkKind: c.chunkKind ?? "turn",
  }));
}

function mergeSpeakerTurns(
  pending: { ts: string; speaker: string; bodies: string[] }[],
  sourceType: SourceType,
  sourceFile: string,
): ParsedChunk[] {
  return withIds(
    pending.map((p) => ({
      text: p.bodies.length ? `${p.speaker}: ${p.bodies.join(" ")}` : `${p.speaker}:`,
      sourceType,
      timestamp: p.ts,
      sourceFile,
      chunkKind: "turn" as const,
    })),
  );
}

/** One speaker turn = one chunk. Consecutive same-speaker turns are merged. */
export function parseMeetingTranscript(content: string, sourceFile: string): ParsedChunk[] {
  const pending: { ts: string; speaker: string; bodies: string[] }[] = [];

  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(MEETING_LINE);
    if (!m?.groups) continue;
    const ts = m.groups.ts.trim();
    const speaker = m.groups.speaker.trim();
    const body = m.groups.body.trim();
    const last = pending[pending.length - 1];
    // Merge consecutive same-speaker lines, but start a new turn before a chunk
    // would exceed MAX_CHUNK_CHARS (clip() would otherwise truncate long turns).
    const lastLen = last ? last.speaker.length + 2 + last.bodies.join(" ").length : 0;
    if (last && last.speaker === speaker && lastLen + body.length + 1 <= MAX_CHUNK_CHARS) {
      if (body) last.bodies.push(body);
    } else {
      pending.push({ ts, speaker, bodies: body ? [body] : [] });
    }
  }

  return mergeSpeakerTurns(pending, "meeting", sourceFile);
}

export function parseSessionLog(content: string, sourceFile: string): ParsedChunk[] {
  const chunks: ParsedChunk[] = [];
  SESSION_HEADER.lastIndex = 0;
  const matches = [...content.matchAll(SESSION_HEADER)];
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i]!;
    const next = matches[i + 1];
    const start = (m.index ?? 0) + m[0].length;
    const end = next?.index ?? content.length;
    const body = content.slice(start, end).trim();
    if (!body) continue;
    chunks.push({
      text: `${m.groups?.role ?? "USER"}: ${body}`,
      sourceType: "code_session",
      timestamp: m.groups?.ts?.trim() ?? "unknown",
      sourceFile,
      chunkKind: "turn",
    });
  }
  SESSION_HEADER.lastIndex = 0;
  return withIds(chunks);
}

export function parseWhatsAppExport(content: string, sourceFile: string): ParsedChunk[] {
  const pending: { ts: string; speaker: string; bodies: string[] }[] = [];
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(WHATSAPP_BRACKET) ?? line.match(WHATSAPP_DASH);
    if (!m?.groups) {
      const last = pending[pending.length - 1];
      if (last) last.bodies.push(line);
      continue;
    }
    pending.push({
      ts: m.groups.ts.trim(),
      speaker: m.groups.speaker.trim(),
      bodies: m.groups.body.trim() ? [m.groups.body.trim()] : [],
    });
  }
  return mergeSpeakerTurns(pending, "whatsapp", sourceFile);
}

export function parseReadAiNotes(content: string, sourceFile: string): ParsedChunk[] {
  const pending: { ts: string; speaker: string; bodies: string[] }[] = [];
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(READAI_CLOCK) ?? line.match(MEETING_LINE);
    if (!m?.groups) continue;
    const ts = m.groups.ts.trim();
    const speaker = m.groups.speaker.trim();
    const body = m.groups.body.trim();
    if (!body) continue;
    const last = pending[pending.length - 1];
    if (last && last.speaker === speaker) last.bodies.push(body);
    else pending.push({ ts, speaker, bodies: [body] });
  }
  if (pending.length) return mergeSpeakerTurns(pending, "readai", sourceFile);
  return parseMeetingTranscript(content, sourceFile).map((c) => ({ ...c, sourceType: "readai" }));
}

export function parseSlackExport(content: string, sourceFile: string): ParsedChunk[] {
  const trimmed = content.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed) as
        | { messages?: { user?: string; text?: string; ts?: string }[] }
        | { user?: string; text?: string; ts?: string }[];
      const messages = Array.isArray(parsed) ? parsed : parsed.messages;
      if (Array.isArray(messages)) {
        return withIds(
          messages
            .filter((m) => m.text?.trim())
            .map((m) => ({
              text: `${(m.user || "member").trim()}: ${m.text!.trim()}`,
              sourceType: "slack" as const,
              timestamp: formatSlackTs(m.ts ?? ""),
              sourceFile,
              chunkKind: "turn" as const,
            })),
        );
      }
    } catch {
      /* fall through to text */
    }
  }

  const lines = content.split(/\r?\n/);
  const chunks: ParsedChunk[] = [];
  let speaker = "member";
  let ts = "";
  let body: string[] = [];

  const flush = () => {
    const text = body.join("\n").trim();
    if (!text) {
      body = [];
      return;
    }
    chunks.push({
      text: `${speaker}: ${text}`,
      sourceType: "slack",
      timestamp: ts || "unknown",
      sourceFile,
      chunkKind: "turn",
    });
    body = [];
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim()) continue;
    const header = line.trim().match(SLACK_HEADER);
    if (header?.groups) {
      flush();
      speaker = header.groups.speaker.trim();
      ts = header.groups.ts.trim();
      continue;
    }
    const meeting = line.trim().match(MEETING_LINE);
    if (meeting?.groups) {
      flush();
      chunks.push({
        text: `${meeting.groups.speaker.trim()}: ${meeting.groups.body.trim()}`,
        sourceType: "slack",
        timestamp: meeting.groups.ts.trim(),
        sourceFile,
        chunkKind: "turn",
      });
      continue;
    }
    body.push(line);
  }
  flush();
  return withIds(chunks);
}

function formatSlackTs(ts: string): string {
  if (!ts) return "unknown";
  const n = Number(ts);
  if (!Number.isFinite(n) || n < 1e9) return ts;
  try {
    return new Date(n * 1000).toISOString();
  } catch {
    return ts;
  }
}

function parseSpeakerCue(text: string): { speaker: string; body: string } {
  const vTag = text.match(/^<v\s+([^>]+)>(.*)$/i);
  if (vTag) return { speaker: vTag[1].trim(), body: vTag[2].replace(/<\/v>/gi, "").trim() };
  const colon = text.match(/^([A-Za-z][\w .'-]{0,40}):\s*(.*)$/);
  if (colon) return { speaker: colon[1].trim(), body: colon[2].trim() };
  return { speaker: "Speaker", body: text.trim() };
}

export function parseVttTranscript(
  content: string,
  sourceFile: string,
  sourceType: SourceType,
): ParsedChunk[] {
  const pending: { ts: string; speaker: string; bodies: string[] }[] = [];
  const lines = content.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]?.trim() ?? "";
    const time = line.match(VTT_TIME);
    if (!time) {
      i += 1;
      continue;
    }
    const ts = line.split("-->")[0]?.trim() ?? line;
    i += 1;
    const cue: string[] = [];
    while (i < lines.length && lines[i]?.trim()) {
      cue.push(lines[i]!.trim());
      i += 1;
    }
    const joined = cue.filter((c) => !/^\d+$/.test(c)).join(" ");
    if (!joined) continue;
    const { speaker, body } = parseSpeakerCue(joined);
    if (!body) continue;
    const last = pending[pending.length - 1];
    if (last && last.speaker === speaker) last.bodies.push(body);
    else pending.push({ ts, speaker, bodies: [body] });
  }
  return mergeSpeakerTurns(pending, sourceType, sourceFile);
}

function parseTeamsChat(content: string, sourceFile: string, sourceType: SourceType): ParsedChunk[] {
  const pending: { ts: string; speaker: string; bodies: string[] }[] = [];
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(TEAMS_BRACKET) ?? line.match(MEETING_LINE);
    if (!m?.groups) continue;
    const ts = m.groups.ts.trim();
    const speaker = m.groups.speaker.trim();
    const body = m.groups.body.trim();
    if (!body) continue;
    const last = pending[pending.length - 1];
    if (last && last.speaker === speaker) last.bodies.push(body);
    else pending.push({ ts, speaker, bodies: [body] });
  }
  return mergeSpeakerTurns(pending, sourceType, sourceFile);
}

type ZoomJson = {
  topic?: string;
  start_time?: string;
  transcript?: { speaker?: string; text?: string; start?: string }[];
  recording_files?: { file_type?: string }[];
  summary?: string;
};

function parseZoomJson(content: string, sourceFile: string): ParsedChunk[] | null {
  try {
    const parsed = JSON.parse(content) as ZoomJson;
    if (Array.isArray(parsed.transcript)) {
      return withIds(
        parsed.transcript
          .filter((t) => t.text?.trim())
          .map((t) => ({
            text: `${(t.speaker || "Speaker").trim()}: ${t.text!.trim()}`,
            sourceType: "zoom" as const,
            timestamp: String(t.start || parsed.start_time || ""),
            sourceFile,
            chunkKind: "turn" as const,
          })),
      );
    }
  } catch {
    return null;
  }
  return null;
}

export function parseVideoMinutes(
  content: string,
  sourceFile: string,
  sourceType: "zoom" | "gmeet" | "teams",
): ParsedChunk[] {
  if (sourceType === "zoom") {
    const json = parseZoomJson(content, sourceFile);
    if (json && json.length) return json;
  }
  const vtt = content.includes("-->") ? parseVttTranscript(content, sourceFile, sourceType) : [];
  const chats = parseTeamsChat(content, sourceFile, sourceType);
  const generic = parseMeetingTranscript(content, sourceFile).map((c) => ({
    ...c,
    sourceType,
  }));
  const seen = new Set<string>();
  const merged: ParsedChunk[] = [];
  for (const c of [...vtt, ...chats, ...generic]) {
    const key = `${c.timestamp}|${c.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push({ ...c, sourceType });
  }
  return withIds(merged);
}

export function parseGitSource(content: string, sourceFile: string): ParsedChunk[] {
  return withIds(chunkGitFiles([{ path: sourceFile, content }], sourceFile.replace(/\.[a-z0-9]+$/i, "")));
}

export function detectSourceType(filename: string, content: string): SourceType {
  const name = filename.toLowerCase();
  if (name.includes("whatsapp") || name.endsWith(".wa.txt")) return "whatsapp";
  if (name.includes("slack") || name.includes("channel")) return "slack";
  if (name.includes("readai") || name.includes("read-ai") || name.includes("read_ai")) {
    return "readai";
  }
  if (name.includes("zoom") || (name.includes("vtt") && name.includes("cloud"))) return "zoom";
  if (name.includes("gmeet") || name.includes("google-meet") || name.includes("google_meet")) {
    return "gmeet";
  }
  if (name.includes("teams") || name.includes("ms-teams")) return "teams";
  if (name.endsWith(".vtt") || content.trimStart().startsWith("WEBVTT")) {
    if (name.includes("meet")) return "gmeet";
    if (name.includes("team")) return "teams";
    return "zoom";
  }
  if (name.endsWith(".log") || SESSION_HEADER.test(content)) {
    SESSION_HEADER.lastIndex = 0;
    if (SESSION_HEADER.test(content) || name.endsWith(".log")) return "code_session";
  }
  SESSION_HEADER.lastIndex = 0;
  if (content.trim().startsWith("{") || content.trim().startsWith("[")) {
    try {
      const parsed = JSON.parse(content) as { messages?: unknown; transcript?: unknown };
      if (Array.isArray(parsed.transcript)) return "zoom";
      if (Array.isArray(parsed) || Array.isArray(parsed.messages)) return "slack";
    } catch {
      /* ignore */
    }
  }
  const sample = content.split(/\r?\n/).slice(0, 40).join("\n");
  if (WHATSAPP_BRACKET.test(sample) || WHATSAPP_DASH.test(sample.split("\n")[0] ?? "")) {
    return "whatsapp";
  }
  if (MEETING_LINE.test(sample.split("\n").find((l) => l.trim()) ?? "")) return "meeting";
  return "meeting";
}

export function parseFile(
  content: string,
  sourceFile: string,
  sourceType?: SourceType,
): ParsedChunk[] {
  const kind = sourceType ?? detectSourceType(sourceFile, content);
  switch (kind) {
    case "meeting":
      return parseMeetingTranscript(content, sourceFile);
    case "code_session":
      return parseSessionLog(content, sourceFile);
    case "whatsapp":
      return parseWhatsAppExport(content, sourceFile);
    case "slack":
      return parseSlackExport(content, sourceFile);
    case "readai":
      return parseReadAiNotes(content, sourceFile);
    case "zoom":
    case "gmeet":
    case "teams":
      return parseVideoMinutes(content, sourceFile, kind);
    case "git":
      return parseGitSource(content, sourceFile);
    default:
      return parseMeetingTranscript(content, sourceFile);
  }
}

export function attachMinutesChunks(
  turns: ParsedChunk[],
  meeting: MeetingRecord | null,
  sourceType: SourceType,
): ParsedChunk[] {
  if (!meeting) return turns;
  const extra = minutesToChunks(meeting, sourceType);
  const seen = new Set(turns.map((c) => c.text));
  return [...turns, ...extra.filter((c) => !seen.has(c.text))];
}

export function assignIds(chunks: ParsedChunk[]): ParsedChunk[] {
  return chunks.filter((c) => c.text.trim().length > 0);
}

export function makeChunkId(c: ParsedChunk): string {
  return chunkId(c.sourceFile, c.timestamp, c.text);
}
