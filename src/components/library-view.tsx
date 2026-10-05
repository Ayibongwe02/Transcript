import { useMemo, useState } from "react";
import { Trash2 } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/page-header";
import { SourceBadge } from "@/components/source-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatWhen } from "@/lib/hub/format";
import { useHub } from "@/lib/hub/store";
import { SOURCE_LABELS, type SourceType } from "@/lib/hub/types";

export function LibraryView() {
  const hydrated = useHub((s) => s.hydrated);
  const documents = useHub((s) => s.documents);
  const chunks = useHub((s) => s.chunks);
  const removeDocument = useHub((s) => s.removeDocument);
  const [q, setQ] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    if (!term) return documents.slice().sort((a, b) => b.ingestedAt.localeCompare(a.ingestedAt));
    return documents
      .filter((d) => {
        if (d.name.toLowerCase().includes(term)) return true;
        return chunks.some((c) => c.documentId === d.id && c.text.toLowerCase().includes(term));
      })
      .sort((a, b) => b.ingestedAt.localeCompare(a.ingestedAt));
  }, [documents, chunks, q]);

  const byType = chunks.reduce(
    (acc, c) => {
      acc[c.sourceType] = (acc[c.sourceType] ?? 0) + 1;
      return acc;
    },
    {} as Partial<Record<SourceType, number>>,
  );

  return (
    <div>
      <PageHeader
        kicker="Index"
        title="Library"
        body="Everything overheard and imported lives here as chunks — type, file, and time."
      />

      <div className="mt-5 flex flex-wrap gap-2">
        {(Object.keys(SOURCE_LABELS) as SourceType[]).map((t) => (
          <span key={t} className="flex items-center gap-2 rounded-full bg-elevated px-3 py-1.5">
            <SourceBadge type={t} />
            <span className="font-mono text-2xs tabular-nums text-muted">{byType[t] ?? 0}</span>
          </span>
        ))}
      </div>

      <Input
        className="mt-6 max-w-md"
        placeholder="Filter files or chunk text"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />

      <ul className="mt-4 flex flex-col gap-2">
        {!hydrated && <li className="text-sm text-muted">Loading index…</li>}
        {hydrated && filtered.length === 0 && (
          <li className="text-sm text-muted">No documents. Listen in, or add a source.</li>
        )}
        {filtered.map((doc) => {
          const open = openId === doc.id;
          const docChunks = chunks.filter((c) => c.documentId === doc.id);
          return (
            <li key={doc.id} className="rounded-xl bg-surface shadow-[var(--shadow-border)]">
              <div className="flex items-start gap-3 p-4">
                <button
                  type="button"
                  className="min-w-0 flex-1 text-left"
                  onClick={() => setOpenId(open ? null : doc.id)}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <SourceBadge type={doc.sourceType} />
                    <span className="truncate text-sm font-medium text-fg">{doc.name}</span>
                  </div>
                  <p className="mt-1 font-mono text-2xs tabular-nums text-subtle">
                    {doc.chunkCount} chunks · {formatBytes(doc.bytes)} · {formatWhen(doc.ingestedAt)}
                  </p>
                </button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Remove ${doc.name}`}
                  onClick={() => {
                    removeDocument(doc.id);
                    toast.message(`Removed ${doc.name}`);
                  }}
                >
                  <Trash2 />
                </Button>
              </div>
              {open && (
                <ul className="border-t border-border px-4 py-3">
                  {docChunks.map((c) => (
                    <li key={c.id} className="border-b border-border py-3 last:border-0">
                      <p className="font-mono text-2xs text-subtle">{c.timestamp}</p>
                      <p className="mt-1 text-sm text-fg">{c.text}</p>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
