import { useState } from "react";
import { FolderOpen, GitBranch, Hash, KeyRound, MessageCircle, Video } from "lucide-react";
import { toast } from "sonner";
import { ConnectDialog } from "@/components/connect-dialog";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { formatWhen } from "@/lib/hub/format";
import { useHub } from "@/lib/hub/store";
import { CONNECTOR_LABELS, type ConnectorKind } from "@/lib/hub/types";
import { cn } from "@/lib/utils";

const CARDS: {
  id: ConnectorKind;
  icon: typeof FolderOpen;
  blurb: string;
}[] = [
  {
    id: "folder",
    icon: FolderOpen,
    blurb: "Drop meeting .txt, session .log, and video VTT files. Always on this device.",
  },
  {
    id: "zoom",
    icon: Video,
    blurb: "Sign in with Zoom, paste a token, or import cloud-recording minutes and VTT.",
  },
  {
    id: "gmeet",
    icon: Video,
    blurb: "Sign in with Google, then sync Meet recaps. Token and file fallback.",
  },
  {
    id: "teams",
    icon: Video,
    blurb: "Sign in with Microsoft. Import a transcript if Graph is unavailable.",
  },
  {
    id: "slack",
    icon: Hash,
    blurb: "OAuth or bot token on this device, then sync channels or ingest an export.",
  },
  {
    id: "readai",
    icon: KeyRound,
    blurb: "Store a Read AI API key locally, sync meetings, or paste a note.",
  },
  {
    id: "whatsapp",
    icon: MessageCircle,
    blurb: "Ingest a WhatsApp chat export. Cloud API token optional.",
  },
  {
    id: "git",
    icon: GitBranch,
    blurb: "The repo the meeting was about. GitHub first; a git URL only if that fails.",
  },
];

export function SourcesView() {
  const connectors = useHub((s) => s.connectors);
  const documents = useHub((s) => s.documents);
  const chunks = useHub((s) => s.chunks);
  const meetings = useHub((s) => s.meetings);
  const repos = useHub((s) => s.repos);
  const revoke = useHub((s) => s.revoke);
  const [open, setOpen] = useState<ConnectorKind | null>(null);

  return (
    <div>
      <PageHeader
        kicker="Connections"
        title="Sources"
        body="Listen is the default. These are extras — sign in, paste a token, or drop an export. Credentials stay in this browser."
      />

      <div className="mt-8 grid gap-3 md:grid-cols-2">
        {CARDS.map((card) => {
          const rec = connectors.find((c) => c.id === card.id);
          const docs = documents.filter((d) => d.connectorId === card.id);
          const nChunks = chunks.filter((c) => c.connectorId === card.id).length;
          const nMeetings = meetings.filter((m) => m.connectorId === card.id).length;
          const nRepos = card.id === "git" ? repos.filter(Boolean).length : 0;
          const Icon = card.icon;
          const connected = rec?.status === "connected";
          return (
            <article
              key={card.id}
              className="flex flex-col rounded-xl bg-surface p-5 shadow-[var(--shadow-border)]"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-3">
                  <span className="flex size-10 items-center justify-center rounded-lg bg-elevated text-muted">
                    <Icon className="size-5" />
                  </span>
                  <div>
                    <h2 className="text-base font-medium text-fg">{CONNECTOR_LABELS[card.id]}</h2>
                    <p className="text-xs text-muted">
                      {connected ? "Connected" : "Disconnected"}
                      {rec?.authMode && rec.authMode !== "none" ? ` · ${rec.authMode}` : ""}
                      {rec?.lastSyncAt ? ` · ${formatWhen(rec.lastSyncAt)}` : ""}
                    </p>
                  </div>
                </div>
                <span
                  className={cn("size-2 rounded-full", connected ? "bg-accent" : "bg-subtle")}
                  aria-hidden
                />
              </div>
              <p className="mt-3 flex-1 text-sm text-muted">{card.blurb}</p>
              <p className="mt-2 font-mono text-2xs tabular-nums text-subtle">
                {docs.length} files · {nChunks} chunks
                {nMeetings ? ` · ${nMeetings} minutes` : ""}
                {nRepos ? ` · ${nRepos} repos` : ""}
                {rec?.hasSecret ? " · token saved" : ""}
              </p>
              <div className="mt-4 flex flex-wrap gap-2">
                <Button size="sm" variant="secondary" onClick={() => setOpen(card.id)}>
                  {card.id === "folder" ? "Sync" : connected ? "Sync" : "Connect"}
                </Button>
                {(connected && card.id !== "folder") || (card.id === "folder" && docs.length > 0) ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      revoke(card.id);
                      toast.message(`${CONNECTOR_LABELS[card.id]} cleared`);
                    }}
                  >
                    Revoke
                  </Button>
                ) : null}
              </div>
            </article>
          );
        })}
      </div>

      <ConnectDialog kind={open} onClose={() => setOpen(null)} />
    </div>
  );
}
