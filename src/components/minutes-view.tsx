import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { Mic } from "lucide-react";
import { toast } from "sonner";
import { MeetingBrief } from "@/components/meeting-brief";
import { PageHeader } from "@/components/page-header";
import { SourceBadge } from "@/components/source-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatWhen } from "@/lib/hub/format";
import { runMeetingAnalysis } from "@/lib/hub/run-meeting-analysis";
import { useHub } from "@/lib/hub/store";
import type { MeetingRecord } from "@/lib/hub/types";

const OPEN_KEY = "knowledge-hub.minutes.openId";

export function MinutesView() {
  const hydrated = useHub((s) => s.hydrated);
  const meetings = useHub((s) => s.meetings);
  const markMeetingEnded = useHub((s) => s.markMeetingEnded);
  const queueAnalysis = useHub((s) => s.queueAnalysis);
  const [q, setQ] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    try {
      const id = sessionStorage.getItem(OPEN_KEY);
      if (id) {
        sessionStorage.removeItem(OPEN_KEY);
        setOpenId(id);
      }
    } catch {
      /* ignore */
    }
  }, []);

  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    const list = meetings.slice().sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    if (!term) return list;
    return list.filter((m) => {
      const blob = [
        m.title,
        m.summary,
        m.attendees.join(" "),
        m.decisions.join(" "),
        m.actionItems.map((a) => `${a.owner} ${a.text}`).join(" "),
        m.analysis?.objective ?? "",
        ...(m.analysis?.topics ?? []),
      ]
        .join(" ")
        .toLowerCase();
      return blob.includes(term);
    });
  }, [meetings, q]);

  const open = filtered.find((m) => m.id === openId) ?? filtered[0] ?? null;

  function askAbout(meeting: MeetingRecord, focus?: "actions" | "decisions") {
    const question =
      focus === "actions"
        ? `What action items came out of "${meeting.title}"?`
        : focus === "decisions"
          ? `What did we decide in "${meeting.title}"?`
          : `Summarize "${meeting.title}": objective, topics, and solutions. Cite the source.`;
    sessionStorage.setItem("knowledge-hub.ask.prefill", question);
    void navigate({ to: "/ask" });
  }

  async function handleReanalyze(meetingId: string) {
    setBusyId(meetingId);
    queueAnalysis(meetingId);
    try {
      await runMeetingAnalysis(meetingId);
    } finally {
      setBusyId(null);
    }
  }

  function handleMarkEnded(meetingId: string) {
    markMeetingEnded(meetingId);
    toast.success("Meeting marked as ended — analysis queued");
  }

  return (
    <div>
      <PageHeader
        kicker="Archive"
        title="Meetings"
        body="Every captured call lands here as a brief: objective, topics, solutions, then the repo it belongs to."
        actions={
          <Button asChild>
            <Link to="/">
              <Mic className="size-4" />
              Listen
            </Link>
          </Button>
        }
      />

      <Input
        className="mt-6 max-w-md"
        placeholder="Filter by title, topic, attendee…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />

      {!hydrated && <p className="mt-6 text-sm text-muted">Loading meetings…</p>}
      {hydrated && filtered.length === 0 && (
        <p className="mt-6 text-sm text-muted">
          No meetings yet. Start listening during the next call, or drop a recap in Sources.
        </p>
      )}

      <div className="mt-6 grid gap-8 lg:grid-cols-[minmax(0,240px)_minmax(0,1fr)]">
        <ul className="flex flex-col gap-0.5">
          {filtered.map((m) => (
            <li key={m.id}>
              <button
                type="button"
                onClick={() => setOpenId(m.id)}
                className={
                  "w-full rounded-lg px-3 py-2.5 text-left transition-colors duration-150 " +
                  (open?.id === m.id ? "bg-elevated" : "hover:bg-elevated/60")
                }
              >
                <div className="flex items-center gap-2">
                  <SourceBadge type={m.platform === "meeting" ? "meeting" : m.platform} />
                  <span className="truncate text-sm text-fg">{m.title}</span>
                </div>
                <p className="mt-1 font-mono text-2xs tabular-nums text-subtle">
                  {formatWhen(m.startedAt)} · {statusLabel(m)}
                </p>
              </button>
            </li>
          ))}
        </ul>

        {open ? (
          <MeetingBrief
            meeting={open}
            busy={busyId === open.id}
            onReanalyze={() => void handleReanalyze(open.id)}
            onMarkEnded={() => handleMarkEnded(open.id)}
            onAsk={(focus) => askAbout(open, focus)}
          />
        ) : null}
      </div>
    </div>
  );
}

function statusLabel(m: MeetingRecord): string {
  if (m.analysisStatus === "pending") return "analysing";
  if (m.analysisStatus === "done") return "analysed";
  if (m.analysisStatus === "failed") return "failed";
  if (m.endedAt) return "ended";
  return `${m.actionItems.length} actions`;
}
