import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { AiProvidersDialog } from "@/components/ai-providers-dialog";
import { AnswerBody } from "@/components/answer-body";
import { SourceBadge } from "@/components/source-badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  AI_PROVIDER_IDS,
  type AiProviderId,
  type AiProvidersState,
  loadAiProviders,
  resolveCallConfig,
  setActiveProvider,
} from "@/lib/hub/ai-providers";
import { fallbackAnswer } from "@/lib/hub/fallback";
import { randomId } from "@/lib/hub/ids";
import { isWeakMatch, retrieve, type RetrieveFilter } from "@/lib/hub/retrieve";
import { SUGGESTED_QUESTIONS } from "@/lib/hub/sample-data";
import { useHub } from "@/lib/hub/store";
import { synthesizeAnswer } from "@/lib/hub/synthesize";
import type { QueryRecord, RetrievedChunk, SourceType } from "@/lib/hub/types";
import { cn } from "@/lib/utils";

const FILTERS: { id: RetrieveFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "minutes", label: "Meetings" },
  { id: "git", label: "Git" },
  { id: "zoom", label: "Zoom" },
  { id: "gmeet", label: "Meet" },
  { id: "teams", label: "Teams" },
  { id: "code_session", label: "Sessions" },
  { id: "slack", label: "Slack" },
];

const PREFILL_KEY = "knowledge-hub.ask.prefill";

const SHORT_LABELS: Record<AiProviderId, string> = {
  grok: "Grok",
  claude: "Claude",
  custom: "Custom",
};

export function AskView() {
  const hydrated = useHub((s) => s.hydrated);
  const chunks = useHub((s) => s.chunks);
  const queries = useHub((s) => s.queries);
  const rememberQuery = useHub((s) => s.rememberQuery);

  const [question, setQuestion] = useState("");
  const [filter, setFilter] = useState<RetrieveFilter>("all");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<QueryRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeCite, setActiveCite] = useState<number | null>(null);
  const [aiState, setAiState] = useState<AiProvidersState>(() => loadAiProviders());
  const inflight = useRef(false);

  useEffect(() => {
    try {
      const pre = sessionStorage.getItem(PREFILL_KEY);
      if (pre) {
        sessionStorage.removeItem(PREFILL_KEY);
        setQuestion(pre);
        setFilter("minutes");
      }
    } catch {
      /* ignore */
    }
  }, []);

  const shown = result ?? queries[0] ?? null;
  const typesInIndex = useMemo(() => new Set(chunks.map((c) => c.sourceType)), [chunks]);

  const selectableProviders = useMemo(() => {
    return AI_PROVIDER_IDS.filter((id) => {
      const p = aiState.providers[id];
      if (id === aiState.activeId) return true;
      if (id === "grok") return true;
      return p.enabled || Boolean(p.apiKey);
    });
  }, [aiState]);

  function selectProvider(id: AiProviderId) {
    setAiState(setActiveProvider(aiState, id));
  }

  async function ask(q: string) {
    const text = q.trim();
    if (!text || inflight.current) return;
    inflight.current = true;
    setLoading(true);
    setError(null);
    setActiveCite(null);
    const sources = retrieve(text, chunks, 5, filter);
    const weak = isWeakMatch(sources);
    const call = resolveCallConfig(aiState);
    const draft: QueryRecord = {
      id: randomId("q"),
      question: text,
      askedAt: new Date().toISOString(),
      answer: "Writing a grounded answer from the retrieved sources…",
      model: `retrieving → ${call.providerId}`,
      noRelevantContext: weak,
      sources,
    };
    setResult(draft);
    try {
      const res = await synthesizeAnswer({
        data: {
          question: text,
          sources,
          noRelevantContext: weak,
          ai: call,
        },
      });
      const record: QueryRecord = {
        ...draft,
        answer: res.ok ? res.answer : fallbackAnswer(sources),
        model: res.ok ? res.model : "fallback",
        noRelevantContext: res.ok ? res.noRelevantContext : weak,
        sources: res.ok ? res.sources : sources,
      };
      if (!res.ok) setError(res.error);
      rememberQuery(record);
      setResult(record);
      setQuestion("");
    } catch (err) {
      const record: QueryRecord = {
        ...draft,
        answer: fallbackAnswer(sources),
        model: "fallback",
      };
      rememberQuery(record);
      setResult(record);
      const msg = err instanceof Error ? err.message : "Ask failed";
      setError(msg);
      toast.error(msg);
    } finally {
      inflight.current = false;
      setLoading(false);
    }
  }

  const visibleFilters = FILTERS.filter((f) => {
    if (f.id === "all" || f.id === "minutes" || f.id === "git" || f.id === "code_session") {
      return true;
    }
    return typesInIndex.has(f.id as SourceType);
  });

  const empty = !shown;

  return (
    <div className={cn("mx-auto flex w-full max-w-2xl flex-col", empty && "min-h-[calc(100dvh-10rem)] justify-center")}>
      {empty ? (
        <div className="mb-8 text-center">
          <p className="text-2xs font-medium tracking-wider text-muted uppercase">Ask the archive</p>
          <h1 className="mt-2 font-display text-4xl leading-tight text-fg">What did we decide?</h1>
          <p className="mx-auto mt-3 max-w-md text-sm text-muted">
            Answers stay grounded in meetings, transcripts, and linked repos on this device.
          </p>
        </div>
      ) : (
        <div className="mb-8">
          <p className="text-2xs font-medium tracking-wider text-muted uppercase">Answer</p>
          <h1 className="mt-1 font-display text-2xl leading-snug text-fg">{shown.question}</h1>
          {shown.noRelevantContext ? (
            <p className="mt-3 text-sm text-warn">Weak match — the index may not contain this.</p>
          ) : null}
          <div className="mt-5">
            <AnswerBody text={shown.answer} active={activeCite} onCite={setActiveCite} />
          </div>
          <p className="mt-3 font-mono text-2xs text-subtle">{shown.model}</p>
          {error ? <p className="mt-2 text-sm text-danger">{error}</p> : null}

          <h2 className="mt-8 text-2xs font-medium tracking-wider text-muted uppercase">
            Sources ({shown.sources.length})
          </h2>
          <ul className="mt-3 flex flex-col gap-2">
            {shown.sources.map((s, i) => (
              <SourceCard
                key={s.id}
                index={i + 1}
                chunk={s}
                active={activeCite === i + 1}
                onSelect={() => setActiveCite(i + 1)}
              />
            ))}
          </ul>
        </div>
      )}

      <form
        className="rounded-xl bg-surface p-2 shadow-[var(--shadow-border)]"
        onSubmit={(e) => {
          e.preventDefault();
          void ask(question);
        }}
      >
        <Textarea
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void ask(question);
            }
          }}
          placeholder="Ask across meetings and the linked repo…"
          className="min-h-20 resize-none"
          disabled={loading || !hydrated}
          rows={2}
        />
        <div className="flex flex-wrap items-center justify-between gap-2 px-2 pb-1">
          <div className="flex flex-wrap items-center gap-1.5">
            {selectableProviders.map((id) => (
              <button
                key={id}
                type="button"
                onClick={() => selectProvider(id)}
                disabled={loading}
                className={cn(
                  "h-8 rounded-full px-2.5 text-xs font-medium",
                  aiState.activeId === id
                    ? "bg-accent text-accent-fg"
                    : "bg-elevated text-muted hover:text-fg",
                )}
              >
                {SHORT_LABELS[id]}
              </button>
            ))}
            <AiProvidersDialog onSaved={setAiState} />
          </div>
          <Button type="submit" disabled={loading || !question.trim() || !hydrated} size="icon-sm">
            {loading ? <Loader2 className="animate-spin" /> : <ArrowUp />}
            <span className="sr-only">Ask</span>
          </Button>
        </div>
      </form>

      <div className="mt-3 flex flex-wrap gap-1.5">
        {visibleFilters.map((f) => (
          <button
            key={f.id}
            type="button"
            onClick={() => setFilter(f.id)}
            className={cn(
              "h-8 rounded-full px-3 text-xs font-medium",
              filter === f.id ? "bg-elevated text-fg" : "text-muted hover:text-fg",
            )}
          >
            {f.label}
          </button>
        ))}
      </div>

      {empty ? (
        <div className="mt-6 flex flex-col gap-1">
          {SUGGESTED_QUESTIONS.map((q) => (
            <button
              key={q}
              type="button"
              onClick={() => void ask(q)}
              disabled={loading || !hydrated}
              className="rounded-lg px-3 py-2.5 text-left text-sm text-muted hover:bg-elevated hover:text-fg"
            >
              {q}
            </button>
          ))}
        </div>
      ) : (
        <aside className="mt-10">
          <p className="text-2xs font-medium tracking-wider text-subtle uppercase">Recent</p>
          <ul className="mt-2 flex flex-col">
            {queries.map((q) => (
              <li key={q.id}>
                <button
                  type="button"
                  onClick={() => {
                    setResult(q);
                    setActiveCite(null);
                  }}
                  className={cn(
                    "w-full rounded-md px-2 py-2 text-left text-sm text-muted hover:bg-elevated hover:text-fg",
                    shown?.id === q.id && "text-fg",
                  )}
                >
                  {q.question}
                </button>
              </li>
            ))}
          </ul>
        </aside>
      )}
    </div>
  );
}

function SourceCard({
  index,
  chunk,
  active,
  onSelect,
}: {
  index: number;
  chunk: RetrievedChunk;
  active: boolean;
  onSelect: () => void;
}) {
  const relevance = Math.max(0, Math.min(1, 1 - chunk.score));
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        className={cn(
          "w-full rounded-xl bg-surface p-4 text-left shadow-[var(--shadow-border)] transition-shadow duration-150",
          active && "shadow-[var(--shadow-border-hover)]",
        )}
      >
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-2xs text-muted">{index}</span>
          <SourceBadge type={chunk.sourceType} />
          <span className="truncate text-xs text-muted">{chunk.sourceFile}</span>
          <span className="ml-auto font-mono text-2xs tabular-nums text-subtle">
            {chunk.timestamp}
          </span>
        </div>
        <p className="mt-2 text-sm leading-relaxed text-fg">{chunk.text}</p>
        <p className="mt-2 font-mono text-2xs tabular-nums text-subtle">
          relevance {(relevance * 100).toFixed(0)}%
        </p>
      </button>
    </li>
  );
}
