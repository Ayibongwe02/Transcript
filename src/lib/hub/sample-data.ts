import type { GitFile } from "./types.ts";

export const SAMPLE_MEETING = `[2025-03-10 09:00] Alice: Good morning everyone. Today's focus is the Q1 product roadmap.
[2025-03-10 09:01] Bob: Agreed. We need to prioritize the search feature and the knowledge hub prototype.
[2025-03-10 09:02] Alice: Exactly. The knowledge hub should pull from meeting transcripts and Claude Code sessions so we can ask cross-source questions.
[2025-03-10 09:03] Carol: I can start the ingestion pipeline this week. Embedding with a local model for MVP is fine.
[2025-03-10 09:05] Bob: Let's target a working retrieval demo by end of March. No auth, local only.
[2025-03-10 09:07] Alice: Perfect. Action items: Carol owns ingest, Bob owns vector store, Alice owns the ask endpoint.
`;

export const SAMPLE_SESSION = `=== Claude Code Session Export ===
Session ID: sess_fake_001
Started: 2025-03-12T14:22:00Z

[USER 2025-03-12T14:22:05Z]
I need to build a simple ingestion parser for meeting transcripts. Chunk by speaker turn. The repo is acme/knowledge-hub.

[ASSISTANT 2025-03-12T14:22:18Z]
Sure. Here's a basic approach: split on timestamped speaker lines, keep each turn as a chunk with metadata source_type=meeting, timestamp, and source_file.

[USER 2025-03-12T14:25:00Z]
Also need the same for Claude Code session logs. Chunk by message boundary.

[ASSISTANT 2025-03-12T14:25:30Z]
For session logs, detect [USER ...] and [ASSISTANT ...] blocks. Each block becomes a chunk with source_type=code_session. Use the ISO timestamp from the header.

[USER 2025-03-12T14:30:00Z]
Great. Shared pydantic model for chunks so the store layer can consume them later.

[ASSISTANT 2025-03-12T14:30:45Z]
Recommended schema: text (str), source_type (Literal["meeting","code_session"]), timestamp (str), source_file (str). Optional chunk_id for upserts.
`;

export const SAMPLE_SLACK = `{
  "messages": [
    {
      "user": "dana",
      "text": "Standup: knowledge hub dual-source retrieval is working on the sample transcripts.",
      "ts": "1741773600"
    },
    {
      "user": "alice",
      "text": "Keep it local-only until we prove the dual-source value. No team sharing yet.",
      "ts": "1741773660"
    },
    {
      "user": "carol",
      "text": "I'll drop the latest session export in the transcripts folder after lunch.",
      "ts": "1741773720"
    }
  ]
}
`;

export const SAMPLE_ZOOM_MINUTES = `Meeting: Q1 knowledge hub review
Date: 2025-03-14 10:00
Platform: Zoom
Participants: Alice, Bob, Carol, Dana

Summary:
Follow-up to the March 10 meeting. Dual-source retrieval is working on the sample transcripts. The team confirmed we stay local-only, single user, until the dual-source value is proven on real data. Zoom cloud recordings should land as first-class minutes so we can ask what was decided without rewatching. After minutes land, the hub should read the git repo Claude Code is on — github.com/acme/knowledge-hub — so questions can cite both the meeting and the code.

Decisions:
- Stay local-only, single user — machine is identity
- Add Zoom, Google Meet, and Teams as first-class minute sources
- Citations must include platform, time, and origin
- OAuth first; paste an API token if the user has no developer app
- Git access prefers the connected GitHub / Claude Code project; a git URL is last resort

Action items:
- Carol: extend ingest to VTT and meeting summaries
- Bob: keep the index on this device
- Alice: add a Minutes inquiry view
- Dana: wire Slack export as a third chat source
- Bob: after minutes, ground answers in acme/knowledge-hub

WEBVTT

00:00:01.000 --> 00:00:06.000
Alice: Welcome back. Today we close the loop on minutes from Zoom, Meet, and Teams.

00:00:06.500 --> 00:00:12.000
Bob: Retrieval already spans the March 10 transcript and the Claude Code session. Minutes should join that index.

00:00:12.500 --> 00:00:18.000
Carol: I'll parse VTT speaker turns and labeled Action items / Decisions blocks this week.

00:00:18.500 --> 00:00:24.000
Dana: Slack stays an export for now. Same chunk schema, different origin.
`;

export const SAMPLE_GMEET_RECAP = `# Search feature sync
Date: 2025-03-13 16:30
Platform: Google Meet
Attendees: Alice, Bob, Priya

## Summary
Google Meet recap. Priya demoed calendar-backed Meet notes. Search should rank meeting minutes alongside session logs so a question like "who owns ingest?" hits both the March 10 meeting and these recaps. Authenticate with Google when possible; otherwise paste a calendar token or drop the recap file.

## Decisions
- Minutes are first-class, not buried inside generic meetings
- OAuth first, API token fallback
- Google Meet recaps sync from Calendar events that have a Meet link

## Action items
- Priya: connect Google Calendar for Meet recaps
- Bob: dual-source retrieval across minutes and sessions
- Alice: let people ask "what were the action items from the last Meet?"

00:00:02.000 --> 00:00:08.000
Priya: The recap is attached to the Calendar event. If we can read the event, we can index the minutes.

00:00:08.500 --> 00:00:14.000
Alice: Same ask API. Ingest changes, not the question shape.

00:00:14.500 --> 00:00:20.000
Bob: Local index, citations with source_type gmeet, timestamp, and the event title.
`;

export const SAMPLE_TEAMS_STANDUP = `Meeting in Engineering
Date: 2025-03-15 09:15
Microsoft Teams
Attendees: Alice Smith, Bob Chen, Carol Diaz

Summary:
Daily standup. Zoom minutes parser is in review. We can already ask "what did we decide about auth?" across the March 10 transcript and the Zoom review. Carol will drop yesterday's Meet recap after this call. Index stays local — no tenant isolation until we host.

Decisions:
- Keep Docker / this browser as the delivery vehicle
- Teams transcripts use the same chunk schema as Zoom and Meet

Action items:
- Carol: ingest Meet recap today
- Alice: Minutes page by Friday
- Bob: confirm Teams VTT parser on this export

[9:15 AM] Alice Smith: Standup: Zoom minutes parser is in review. We can ask "what did we decide about auth?"

[9:16 AM] Bob Chen: Index is still local. No tenant isolation needed until hosted.

[9:17 AM] Carol Diaz: I'll drop yesterday's Meet recap after this call.
`;

export const SAMPLE_GIT_FILES: GitFile[] = [
  {
    path: "README.md",
    content: `# knowledge-hub

Local-only retrieval across meeting minutes and Claude Code sessions.

Chunk schema (shared pydantic model):
- text: str
- source_type: meeting | code_session | git
- timestamp: str
- source_file: str
- chunk_id: optional, used for upserts

The ingest pipeline chunks transcripts by speaker turn. After a meeting is filed,
review the git repo Claude Code is on so answers can cite both minutes and code.
A git URL is only used if GitHub / Claude Code cannot reach the project.
`,
  },
  {
    path: "src/ingest.py",
    content: `from typing import Literal
from pydantic import BaseModel

SourceType = Literal["meeting", "code_session", "git"]

class Chunk(BaseModel):
    text: str
    source_type: SourceType
    timestamp: str
    source_file: str
    chunk_id: str | None = None

def chunk_speaker_turns(raw: str, source_file: str) -> list[Chunk]:
    """Split timestamped speaker lines into one chunk per turn."""
    chunks: list[Chunk] = []
    for line in raw.splitlines():
        if ":" not in line:
            continue
        chunks.append(
            Chunk(
                text=line.strip(),
                source_type="meeting",
                timestamp="unknown",
                source_file=source_file,
            )
        )
    return chunks
`,
  },
  {
    path: "src/retrieve.py",
    content: `def search(question: str, chunks: list, top_k: int = 5):
    """Local BM25 over indexed minutes, sessions, and git files."""
    scored = []
    q = set(question.lower().split())
    for c in chunks:
        words = set(c.text.lower().split())
        score = len(q & words)
        if score:
            scored.append((score, c))
    scored.sort(key=lambda x: -x[0])
    return [c for _, c in scored[:top_k]]
`,
  },
];

export const SUGGESTED_QUESTIONS = [
  "What was the objective of the Zoom Q1 review?",
  "Which solutions were proposed for the ingest pipeline?",
  "Does the knowledge-hub repo match what we decided about the chunk schema?",
  "Who owns ingest according to Teams, the meeting transcript, and the code session?",
];
