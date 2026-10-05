import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extractMinutes } from "./minutes.ts";
import {
  detectSourceType,
  parseFile,
  parseMeetingTranscript,
  parseSessionLog,
  parseSlackExport,
  parseVideoMinutes,
  parseWhatsAppExport,
} from "./parsers.ts";
import {
  SAMPLE_GMEET_RECAP,
  SAMPLE_MEETING,
  SAMPLE_SESSION,
  SAMPLE_SLACK,
  SAMPLE_TEAMS_STANDUP,
  SAMPLE_ZOOM_MINUTES,
} from "./sample-data.ts";
import { retrieve } from "./retrieve.ts";
import type { Chunk } from "./types.ts";
import { makeChunkId } from "./parsers.ts";

describe("meeting parser", () => {
  it("chunks sample meeting into 6 speaker turns", () => {
    const chunks = parseMeetingTranscript(SAMPLE_MEETING, "sample_meeting.txt");
    assert.equal(chunks.length, 6);
    assert.equal(chunks[0]?.sourceType, "meeting");
    assert.match(chunks[0]?.text ?? "", /^Alice:/);
    assert.ok(chunks.some((c) => c.text.includes("Carol owns ingest")));
  });

  it("merges consecutive turns from the same speaker", () => {
    const text = `[2025-03-10 09:00] Alice: One.
[2025-03-10 09:00] Alice: Two.
[2025-03-10 09:01] Bob: Three.`;
    const chunks = parseMeetingTranscript(text, "m.txt");
    assert.equal(chunks.length, 2);
    assert.match(chunks[0]?.text ?? "", /One\. Two\./);
  });
});

describe("session parser", () => {
  it("chunks sample session into 6 message turns", () => {
    const chunks = parseSessionLog(SAMPLE_SESSION, "sample_session.log");
    assert.equal(chunks.length, 6);
    assert.equal(chunks[0]?.sourceType, "code_session");
    assert.match(chunks[0]?.text ?? "", /^USER:/);
    assert.ok(chunks.some((c) => c.text.includes("source_type=code_session")));
  });
});

describe("slack / whatsapp", () => {
  it("parses slack JSON messages", () => {
    const chunks = parseSlackExport(SAMPLE_SLACK, "eng.json");
    assert.equal(chunks.length, 3);
    assert.equal(chunks[0]?.sourceType, "slack");
    assert.match(chunks[0]?.text ?? "", /^dana:/);
  });

  it("parses whatsapp export lines", () => {
    const raw = `[3/10/25, 9:02:00 AM] Alice: Keep it local only
[3/10/25, 9:03:12 AM] Bob: Drop the session log after lunch`;
    const chunks = parseWhatsAppExport(raw, "chat.txt");
    assert.equal(chunks.length, 2);
    assert.equal(chunks[0]?.sourceType, "whatsapp");
  });
});

describe("video minutes", () => {
  it("parses zoom VTT speaker turns", () => {
    const chunks = parseVideoMinutes(SAMPLE_ZOOM_MINUTES, "zoom.txt", "zoom");
    assert.ok(chunks.length >= 4);
    assert.equal(chunks[0]?.sourceType, "zoom");
    assert.ok(chunks.some((c) => c.text.includes("Welcome back")));
  });

  it("extracts action items and decisions from zoom minutes", () => {
    const turns = parseVideoMinutes(SAMPLE_ZOOM_MINUTES, "zoom.txt", "zoom");
    const meeting = extractMinutes({
      content: SAMPLE_ZOOM_MINUTES,
      sourceFile: "zoom.txt",
      sourceType: "zoom",
      connectorId: "zoom",
      documentId: "d1",
      chunks: turns,
    });
    assert.ok(meeting);
    assert.match(meeting?.title ?? "", /Q1 knowledge hub review/i);
    assert.ok((meeting?.actionItems.length ?? 0) >= 3);
    assert.ok((meeting?.decisions.length ?? 0) >= 2);
    assert.ok(meeting?.attendees.includes("Alice"));
  });

  it("parses google meet recap and teams standup", () => {
    const meet = extractMinutes({
      content: SAMPLE_GMEET_RECAP,
      sourceFile: "gmeet.md",
      sourceType: "gmeet",
      connectorId: "gmeet",
      documentId: "d2",
      chunks: parseFile(SAMPLE_GMEET_RECAP, "gmeet.md", "gmeet"),
    });
    assert.ok(meet);
    assert.match(meet?.title ?? "", /Search feature/i);
    const teams = parseFile(SAMPLE_TEAMS_STANDUP, "teams.txt", "teams");
    assert.ok(teams.some((c) => c.sourceType === "teams"));
    assert.ok(teams.some((c) => c.text.includes("Alice Smith")));
  });
});

describe("detect + retrieve", () => {
  it("detects session logs and zoom files", () => {
    assert.equal(detectSourceType("sample_session.log", SAMPLE_SESSION), "code_session");
    assert.equal(detectSourceType("sample_meeting.txt", SAMPLE_MEETING), "meeting");
    assert.equal(detectSourceType("zoom_q1_review.txt", SAMPLE_ZOOM_MINUTES), "zoom");
  });

  it("pulls both source types for the alignment question", () => {
    const parsed = [
      ...parseFile(SAMPLE_MEETING, "sample_meeting.txt", "meeting"),
      ...parseFile(SAMPLE_SESSION, "sample_session.log", "code_session"),
    ];
    const chunks: Chunk[] = parsed.map((p) => ({
      id: makeChunkId(p),
      text: p.text,
      sourceType: p.sourceType,
      timestamp: p.timestamp,
      sourceFile: p.sourceFile,
      documentId: "d",
      connectorId: "folder",
      chunkKind: p.chunkKind ?? "turn",
    }));
    const hits = retrieve(
      "Does what we found in the Claude Code session align with what was discussed in the meeting?",
      chunks,
      5,
    );
    const types = new Set(hits.map((h) => h.sourceType));
    assert.ok(types.has("meeting"), "expected a meeting hit");
    assert.ok(types.has("code_session"), "expected a session hit");
  });

  it("retrieves zoom action items for a minutes question", () => {
    const parsed = parseFile(SAMPLE_ZOOM_MINUTES, "zoom.txt", "zoom");
    const meeting = extractMinutes({
      content: SAMPLE_ZOOM_MINUTES,
      sourceFile: "zoom.txt",
      sourceType: "zoom",
      connectorId: "zoom",
      documentId: "d",
      chunks: parsed,
    });
    const extra = meeting
      ? [
          ...meeting.actionItems.map((a, i) => ({
            text: `Action item (${meeting.title}): ${a.owner} — ${a.text}`,
            sourceType: "zoom" as const,
            timestamp: `a${i}`,
            sourceFile: "zoom.txt",
            chunkKind: "action" as const,
          })),
        ]
      : [];
    const chunks: Chunk[] = [...parsed, ...extra].map((p) => ({
      id: makeChunkId(p),
      text: p.text,
      sourceType: p.sourceType,
      timestamp: p.timestamp,
      sourceFile: p.sourceFile,
      documentId: "d",
      connectorId: "zoom",
      chunkKind: p.chunkKind ?? "turn",
    }));
    const hits = retrieve("What action items came out of the Zoom Q1 review?", chunks, 5, "minutes");
    assert.ok(hits.length > 0);
    assert.ok(
      hits.some((h) => /action|carol|alice|ingest|minutes/i.test(h.text)),
      "expected an action-item related hit",
    );
  });
});
