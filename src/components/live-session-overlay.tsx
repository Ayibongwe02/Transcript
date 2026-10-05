import { useEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  GripHorizontal,
  Loader2,
  Mic,
  MicOff,
  Monitor,
  Pause,
  Play,
  Settings2,
  Square,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatElapsed } from "@/lib/hub/format";
import {
  type AudioSourceMode,
  type LiveListenState,
} from "@/lib/hub/live-session";
import {
  DEFAULT_STT,
  loadSttProviders,
  saveSttProviders,
  type SttProviderId,
  type SttProvidersState,
} from "@/lib/hub/stt-providers";
import { useHub } from "@/lib/hub/store";
import { useLiveSession } from "@/lib/hub/use-live-session";
import { cn } from "@/lib/utils";

function stateLabel(state: LiveListenState, sttPaused: boolean): string {
  if (sttPaused && state === "likely_muted") return "Muted · paused";
  switch (state) {
    case "requesting":
      return "Requesting audio";
    case "listening":
      return "Listening";
    case "speaking":
      return "Speaking";
    case "silent":
      return "Quiet";
    case "likely_muted":
      return "Can't hear";
    case "paused":
      return "Paused";
    case "error":
      return "Error";
    default:
      return "Idle";
  }
}

export function LiveSessionOverlay({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const ingestText = useHub((s) => s.ingestText);
  const navigate = useNavigate();
  const { engine, snap, live } = useLiveSession();
  const [busy, setBusy] = useState(false);
  const [pos, setPos] = useState({ x: 24, y: 24 });
  const [showSettings, setShowSettings] = useState(false);
  const [stt, setStt] = useState<SttProvidersState>(() => loadSttProviders());
  const [audioSource, setAudioSource] = useState<AudioSourceMode>("system");
  const drag = useRef<{ dx: number; dy: number } | null>(null);

  useEffect(() => {
    if (!open) return;
    setStt(loadSttProviders());
    const w = typeof window !== "undefined" ? window.innerWidth : 400;
    const h = typeof window !== "undefined" ? window.innerHeight : 400;
    setPos({ x: Math.max(16, w - 360), y: Math.max(16, h - 380) });
  }, [open]);

  if (!open) return null;

  function persistStt(next: SttProvidersState) {
    setStt(next);
    saveSttProviders(next);
  }

  async function handleStart() {
    setBusy(true);
    try {
      saveSttProviders(stt);
      await engine.start({ audioSource });
      const s = engine.snapshot();
      if (s.state === "error") toast.error(s.error || "Could not start session");
    } finally {
      setBusy(false);
    }
  }

  async function handlePauseResume() {
    if (snap.state === "paused") await engine.resume();
    else engine.pause();
  }

  async function handleEndAnalyze() {
    setBusy(true);
    try {
      const text = await engine.stop();
      if (!text.trim()) {
        toast.error("No speech was captured.");
        onClose();
        return;
      }
      const title = `Live session ${new Date().toLocaleString()}`;
      const content = [
        `Meeting: ${title}`,
        `Date: ${new Date().toISOString()}`,
        `STT: ${snap.sttProvider}`,
        `Audio: ${snap.audioSource}`,
        "",
        text,
      ].join("\n");
      const res = ingestText({
        name: `live-session-${Date.now()}.txt`,
        content,
        connectorId: "folder",
        sourceType: "meeting",
      });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      if (res.meetingId) {
        try {
          sessionStorage.setItem("knowledge-hub.minutes.openId", res.meetingId);
        } catch {
          /* ignore */
        }
      }
      toast.success("Saved. Analysis is running.");
      onClose();
      void navigate({ to: "/minutes" });
    } finally {
      setBusy(false);
    }
  }

  function onPointerDown(e: React.PointerEvent) {
    if ((e.target as HTMLElement).closest("button, input, select, label")) return;
    drag.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }

  function onPointerMove(e: React.PointerEvent) {
    if (!drag.current) return;
    setPos({
      x: Math.max(8, e.clientX - drag.current.dx),
      y: Math.max(8, e.clientY - drag.current.dy),
    });
  }

  function onPointerUp() {
    drag.current = null;
  }

  const levelPct = Math.min(100, Math.round(snap.level * 280));

  return (
    <div
      role="dialog"
      aria-label="Live meeting session"
      className="fixed z-[80] w-[min(22rem,calc(100vw-1.5rem))] select-none rounded-xl bg-surface/95 shadow-[var(--shadow-border),var(--shadow-float)] backdrop-blur-md"
      style={{ left: pos.x, top: pos.y }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      <div className="flex cursor-grab items-center gap-2 border-b border-border px-3 py-2 active:cursor-grabbing">
        <GripHorizontal className="size-4 text-muted" />
        <span className="text-2xs font-medium tracking-wide text-muted uppercase">Listening</span>
        <button
          type="button"
          className="ml-auto rounded-md p-1 text-muted hover:bg-elevated hover:text-fg"
          aria-label="Session settings"
          onClick={() => setShowSettings((v) => !v)}
        >
          <Settings2 className="size-4" />
        </button>
        <button
          type="button"
          className="rounded-md p-1 text-muted hover:bg-elevated hover:text-fg"
          aria-label="Close overlay"
          onClick={() => {
            void engine.stop();
            onClose();
          }}
        >
          <X className="size-4" />
        </button>
      </div>

      <div className="flex flex-col gap-3 p-3">
        {showSettings && (
          <div className="flex flex-col gap-3 rounded-lg bg-elevated/50 p-3">
            <div className="flex flex-col gap-1.5">
              <Label>Audio source</Label>
              <select
                className="h-9 rounded-md bg-surface px-2 text-sm text-fg shadow-[var(--shadow-border)]"
                value={audioSource}
                disabled={live}
                onChange={(e) => setAudioSource(e.target.value as AudioSourceMode)}
              >
                <option value="mic">Microphone only</option>
                <option value="system">System / tab audio</option>
                <option value="both">Mic + system</option>
              </select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>Speech-to-text</Label>
              <select
                className="h-9 rounded-md bg-surface px-2 text-sm text-fg shadow-[var(--shadow-border)]"
                value={stt.activeId}
                onChange={(e) =>
                  persistStt({ ...stt, activeId: e.target.value as SttProviderId })
                }
              >
                <option value="browser">Browser (free)</option>
                <option value="deepgram">Deepgram</option>
                <option value="whisper">Whisper</option>
              </select>
            </div>
            {stt.activeId === "deepgram" && (
              <Input
                type="password"
                value={stt.deepgramKey}
                placeholder="Deepgram API key"
                onChange={(e) => persistStt({ ...stt, deepgramKey: e.target.value })}
              />
            )}
            {stt.activeId === "whisper" && (
              <>
                <Input
                  type="password"
                  value={stt.whisperKey}
                  placeholder={DEFAULT_STT.whisperBaseUrl}
                  onChange={(e) => persistStt({ ...stt, whisperKey: e.target.value })}
                />
                <Input
                  value={stt.whisperModel}
                  onChange={(e) => persistStt({ ...stt, whisperModel: e.target.value })}
                />
              </>
            )}
          </div>
        )}

        <div className="flex items-center justify-between gap-2">
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-fg">
            {snap.state === "likely_muted" ? (
              <MicOff className="size-3.5 text-danger" />
            ) : audioSource !== "mic" ? (
              <Monitor className="size-3.5 text-muted" />
            ) : (
              <Mic className="size-3.5 text-muted" />
            )}
            {stateLabel(snap.state, snap.sttPaused)}
          </span>
          <span className="font-mono text-xs tabular-nums text-muted">
            {formatElapsed(snap.elapsedMs)}
          </span>
        </div>

        <div className="h-1 overflow-hidden rounded-full bg-elevated">
          <div
            className={cn(
              "h-full rounded-full transition-[width] duration-100",
              snap.state === "likely_muted"
                ? "bg-danger/70"
                : snap.state === "speaking"
                  ? "bg-accent"
                  : "bg-muted/60",
            )}
            style={{ width: `${levelPct}%` }}
          />
        </div>

        {(snap.partial || snap.transcript) && (
          <p className="max-h-24 overflow-y-auto text-xs leading-relaxed text-muted">
            <span className="text-fg">{snap.transcript.slice(-320)}</span>
            {snap.partial ? <span className="text-subtle"> {snap.partial}</span> : null}
          </p>
        )}

        {snap.error && <p className="text-xs text-danger">{snap.error}</p>}

        <div className="flex flex-wrap gap-2">
          {!live ? (
            <Button size="sm" disabled={busy} onClick={() => void handleStart()}>
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Mic className="size-3.5" />}
              Start
            </Button>
          ) : (
            <>
              <Button size="sm" variant="secondary" disabled={busy} onClick={() => void handlePauseResume()}>
                {snap.state === "paused" ? <Play className="size-3.5" /> : <Pause className="size-3.5" />}
                {snap.state === "paused" ? "Resume" : "Pause"}
              </Button>
              <Button size="sm" disabled={busy} onClick={() => void handleEndAnalyze()}>
                {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Square className="size-3.5" />}
                End & analyse
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
