import { useState } from "react";
import { Check, ClipboardCopy, Flag, GitBranch, Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { LinkRepoPanel } from "@/components/link-repo-panel";
import { SourceBadge } from "@/components/source-badge";
import { Button } from "@/components/ui/button";
import { formatWhen } from "@/lib/hub/format";
import { useHub } from "@/lib/hub/store";
import type { MeetingAnalysis, MeetingRecord, ProposedPatch } from "@/lib/hub/types";
import { cn } from "@/lib/utils";

export function MeetingBrief({
  meeting,
  busy,
  onReanalyze,
  onMarkEnded,
  onAsk,
}: {
  meeting: MeetingRecord;
  busy: boolean;
  onReanalyze: () => void;
  onMarkEnded: () => void;
  onAsk: (focus?: "actions" | "decisions") => void;
}) {
  const chunks = useHub((s) => s.chunks);
  const transcript = chunks
    .filter((c) => c.documentId === meeting.documentId)
    .map((c) => c.text);
  const pending = meeting.analysisStatus === "pending" || busy;

  return (
    <article className="min-w-0">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <SourceBadge type={meeting.platform === "meeting" ? "meeting" : meeting.platform} />
          <h2 className="mt-3 font-display text-3xl leading-tight text-fg">{meeting.title}</h2>
          <p className="mt-2 font-mono text-2xs tabular-nums text-subtle">
            {formatWhen(meeting.startedAt)}
            {meeting.endedAt ? ` · ended ${formatWhen(meeting.endedAt)}` : ""}
          </p>
          {meeting.attendees.length > 0 ? (
            <p className="mt-2 text-sm text-muted">{meeting.attendees.join(" · ")}</p>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="ghost" onClick={() => onAsk()}>
            Ask about this
          </Button>
          {!meeting.endedAt ? (
            <Button size="sm" variant="ghost" onClick={onMarkEnded}>
              <Flag className="size-3.5" />
              Mark ended
            </Button>
          ) : null}
          <Button size="sm" variant="ghost" disabled={pending} onClick={onReanalyze}>
            {pending ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
            Re-analyse
          </Button>
        </div>
      </div>

      {pending ? (
        <p className="shimmer-text mt-8 text-sm">Writing the brief from the transcript…</p>
      ) : null}

      {meeting.analysisStatus === "failed" ? (
        <div className="mt-6 rounded-lg bg-elevated px-4 py-3 text-sm text-muted">
          Analysis failed{meeting.analysisError ? `: ${meeting.analysisError}` : "."} Add a Claude
          or Grok key under Ask if needed.{" "}
          <button type="button" className="text-fg underline-offset-2 hover:underline" onClick={onReanalyze}>
            Retry
          </button>
        </div>
      ) : null}

      {meeting.analysis ? <AnalysisSections analysis={meeting.analysis} /> : null}

      {!meeting.analysis && !pending && meeting.summary ? (
        <section className="mt-8">
          <h3 className="text-2xs font-medium tracking-wider text-muted uppercase">Summary</h3>
          <p className="mt-2 text-sm leading-relaxed text-fg">{meeting.summary}</p>
        </section>
      ) : null}

      <LinkRepoPanel meeting={meeting} />

      {transcript.length > 0 ? (
        <details className="mt-8 rounded-xl bg-surface p-4 shadow-[var(--shadow-border)]">
          <summary className="cursor-pointer text-sm font-medium text-fg">Transcript</summary>
          <ul className="mt-3 flex flex-col gap-3">
            {transcript.map((t, i) => (
              <li key={i} className="text-sm leading-relaxed text-muted">
                {t}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </article>
  );
}

function AnalysisSections({ analysis }: { analysis: MeetingAnalysis }) {
  const topics = analysis.topics ?? [];
  const solutions = analysis.solutions ?? [];
  const hasDecisions = analysis.keyDecisions.length > 0;
  const hasActions = analysis.actionItems.length > 0;
  const hasTechnical = analysis.technicalImplications.length > 0;
  const hasPatches = analysis.proposedPatches.length > 0;
  const hasRisks = analysis.risks.length > 0;
  const hasNext = analysis.nextSteps.length > 0;

  return (
    <div className="mt-8 flex flex-col gap-8">
      <section>
        <h3 className="text-2xs font-medium tracking-wider text-muted uppercase">Objective</h3>
        <p className="mt-3 font-display text-xl leading-snug text-fg">{analysis.objective}</p>
        <p className="mt-2 font-mono text-2xs text-subtle">
          {analysis.model} · {formatWhen(analysis.generatedAt)}
        </p>
      </section>

      {topics.length > 0 ? (
        <section>
          <h3 className="text-2xs font-medium tracking-wider text-muted uppercase">Topics</h3>
          <div className="mt-3 flex flex-wrap gap-2">
            {topics.map((t) => (
              <span
                key={t}
                className="rounded-full bg-elevated px-3 py-1.5 text-xs text-fg"
              >
                {t}
              </span>
            ))}
          </div>
        </section>
      ) : null}

      {solutions.length > 0 ? (
        <section>
          <h3 className="text-2xs font-medium tracking-wider text-muted uppercase">
            Solutions
          </h3>
          <ol className="mt-3 flex flex-col gap-2">
            {solutions.map((s, i) => (
              <li key={s} className="flex gap-3 rounded-lg bg-elevated px-3 py-2.5">
                <span className="font-mono text-2xs tabular-nums text-subtle">{i + 1}</span>
                <span className="text-sm text-fg">{s}</span>
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      {hasPatches ? (
        <section>
          <h3 className="flex items-center gap-2 text-2xs font-medium tracking-wider text-muted uppercase">
            <GitBranch className="size-3.5" />
            Suggested patches
          </h3>
          <p className="mt-1 text-xs text-muted">
            Review only — nothing is applied automatically.
          </p>
          <div className="mt-3 flex flex-col gap-3">
            {analysis.proposedPatches.map((p, i) => (
              <PatchCard key={`${p.file}-${i}`} patch={p} />
            ))}
          </div>
        </section>
      ) : null}

      <div className="grid gap-6 min-[560px]:grid-cols-2">
        {hasDecisions ? (
          <ListBlock title="Decisions" items={analysis.keyDecisions} />
        ) : null}
        {hasActions ? (
          <section>
            <HeaderCount title="Action items" count={analysis.actionItems.length} />
            <ul className="mt-2 flex flex-col gap-2">
              {analysis.actionItems.map((a, i) => (
                <li
                  key={`${a.owner}-${i}`}
                  className="flex flex-wrap items-baseline gap-2 rounded-lg bg-elevated px-3 py-2"
                >
                  <span className="text-2xs font-medium tracking-wider text-muted uppercase">
                    {a.owner}
                  </span>
                  {a.priority ? (
                    <span className="rounded bg-surface px-1.5 py-0.5 font-mono text-2xs uppercase text-subtle">
                      {a.priority}
                    </span>
                  ) : null}
                  <span className="text-sm text-fg">{a.text}</span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        {hasTechnical ? (
          <ListBlock title="Technical implications" items={analysis.technicalImplications} />
        ) : null}
        {hasRisks ? <ListBlock title="Risks & open questions" items={analysis.risks} /> : null}
      </div>

      {hasNext ? <ListBlock title="Next steps" items={analysis.nextSteps} /> : null}
    </div>
  );
}

function HeaderCount({ title, count }: { title: string; count: number }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <h3 className="text-2xs font-medium tracking-wider text-muted uppercase">{title}</h3>
      <span className="font-mono text-2xs tabular-nums text-subtle">{count}</span>
    </div>
  );
}

function ListBlock({ title, items }: { title: string; items: string[] }) {
  return (
    <section>
      <HeaderCount title={title} count={items.length} />
      <ul className="mt-2 flex flex-col gap-2">
        {items.map((d) => (
          <li key={d} className="rounded-lg bg-elevated px-3 py-2 text-sm text-fg">
            {d}
          </li>
        ))}
      </ul>
    </section>
  );
}

function PatchCard({ patch }: { patch: ProposedPatch }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    const text = [`# ${patch.file}`, patch.description, "", patch.diff].filter(Boolean).join("\n");
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      toast.success("Patch copied");
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Could not copy");
    }
  }

  return (
    <div className="rounded-xl bg-elevated/70 p-3 shadow-[var(--shadow-border)]">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="font-mono text-xs text-muted">{patch.file}</p>
          {patch.description ? <p className="mt-1 text-sm text-fg">{patch.description}</p> : null}
        </div>
        <Button size="sm" variant="ghost" onClick={() => void copy()}>
          {copied ? <Check className="size-3.5" /> : <ClipboardCopy className="size-3.5" />}
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      {patch.diff ? (
        <pre
          className={cn(
            "mt-3 max-h-48 overflow-auto rounded-lg bg-surface p-3 font-mono text-2xs leading-relaxed text-fg whitespace-pre-wrap",
          )}
        >
          {patch.diff}
        </pre>
      ) : null}
    </div>
  );
}
