import { useEffect, useState, useRef, useMemo } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  Eye,
  EyeOff,
  Loader2,
  Mic,
  MicOff,
  Monitor,
  Pause,
  Play,
  Settings2,
  Square,
  Sparkles,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatElapsed, formatWhen } from "@/lib/hub/format";
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
import {
  hasCompletedOnboarding,
  ONBOARDING_COMPLETE_EVENT,
} from "@/lib/onboarding";
import { useHub } from "@/lib/hub/store";
import { useLiveSession } from "@/lib/hub/use-live-session";
import { cn } from "@/lib/utils";

const SOURCES: { id: AudioSourceMode; label: string; hint: string }[] = [
  { id: "mic", label: "Microphone", hint: "Your voice" },
  { id: "system", label: "System audio", hint: "Zoom / Teams / Meet" },
  { id: "both", label: "Both", hint: "Mic + speakers" },
];

const DEMO_LINES = [
  "Alright, let's recap the sprint goals.",
  "The design system should feel like iOS — glass, motion, color.",
  "When recording starts, the waves should fill the screen.",
  "Hide the transcript if you just want the animation.",
  "Colors cycle through cyan, indigo, violet, and rose.",
];

function stateLabel(state: LiveListenState, sttPaused: boolean): string {
  if (sttPaused && state === "likely_muted") return "Muted · transcription paused";
  switch (state) {
    case "requesting":
      return "Requesting audio";
    case "listening":
      return "Listening";
    case "speaking":
      return "Hearing speech";
    case "silent":
      return "Quiet";
    case "likely_muted":
      return "Can't hear audio";
    case "paused":
      return "Paused";
    case "error":
      return "Something went wrong";
    default:
      return "Ready";
  }
}

export function ListenView() {
  const navigate = useNavigate();
  const ingestText = useHub((s) => s.ingestText);
  const meetings = useHub((s) => s.meetings);
  const hydrated = useHub((s) => s.hydrated);
  const { engine, snap, live } = useLiveSession();
  const [busy, setBusy] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [stt, setStt] = useState<SttProvidersState>(() => loadSttProviders());
  const [audioSource, setAudioSource] = useState<AudioSourceMode>("system");

  // Tour must finish before the studio demo starts
  const [tourDone, setTourDone] = useState(() =>
    typeof window !== "undefined" ? hasCompletedOnboarding() : false,
  );
  const [demo, setDemo] = useState(false);
  const [demoPaused, setDemoPaused] = useState(false);
  const [demoElapsed, setDemoElapsed] = useState(0);
  const [demoLevel, setDemoLevel] = useState(0.45);
  const [demoState, setDemoState] = useState<LiveListenState>("speaking");
  const [demoTranscript, setDemoTranscript] = useState("");
  const [demoPartial, setDemoPartial] = useState("");
  const [studioEntered, setStudioEntered] = useState(false);

  useEffect(() => {
    setStt(loadSttProviders());
  }, []);

  // Listen for tour completion (and pick up if tour already done)
  useEffect(() => {
    const sync = () => setTourDone(hasCompletedOnboarding());
    sync();
    window.addEventListener(ONBOARDING_COMPLETE_EVENT, sync);
    // Poll once after boot in case tour finished via skip without event in edge cases
    const id = window.setInterval(sync, 400);
    return () => {
      window.removeEventListener(ONBOARDING_COMPLETE_EVENT, sync);
      window.clearInterval(id);
    };
  }, []);

  // After tour → seamless handoff into the studio demo
  useEffect(() => {
    if (!tourDone || live) return;
    const t = window.setTimeout(() => {
      setDemo(true);
      // One more frame so CSS enter animation can run
      requestAnimationFrame(() => setStudioEntered(true));
    }, 380);
    return () => window.clearTimeout(t);
  }, [tourDone, live]);

  // Simulated live levels + transcript while demo is running
  useEffect(() => {
    if (!demo || live || demoPaused) return;
    const started = Date.now() - demoElapsed;
    let raf = 0;
    const tick = () => {
      const t = (Date.now() - started) / 1000;
      const speaking = Math.sin(t * 1.15) > -0.12;
      setDemoElapsed(Date.now() - started);
      setDemoState(speaking ? "speaking" : "listening");
      // Smooth level curve — no hard jumps
      const target = speaking
        ? 0.32 + 0.55 * Math.abs(Math.sin(t * 4.4) * Math.sin(t * 1.6 + 0.4))
        : 0.12 + 0.06 * Math.abs(Math.sin(t * 2.1));
      setDemoLevel((prev) => prev + (target - prev) * 0.18);
      const line = DEMO_LINES[Math.floor(t / 4.2) % DEMO_LINES.length];
      const chars = Math.min(line.length, Math.floor(((t % 4.2) / 3.4) * line.length));
      const doneLines = Math.floor(t / 4.2);
      const committed = DEMO_LINES.slice(0, doneLines % DEMO_LINES.length).join(" ");
      setDemoTranscript(committed);
      setDemoPartial(line.slice(0, chars));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [demo, live, demoPaused]);

  function persistStt(next: SttProvidersState) {
    setStt(next);
    saveSttProviders(next);
  }

  async function handleStart() {
    setDemo(false);
    setStudioEntered(false);
    setBusy(true);
    try {
      saveSttProviders(stt);
      await engine.start({ audioSource });
      const s = engine.snapshot();
      if (s.state === "error") {
        toast.error(s.error || "Could not start listening");
      } else if (stt.activeId === "browser" && !s.speechSupported) {
        toast.message("Audio is on", {
          description:
            "Browser speech recognition is unavailable. Switch to Deepgram or Whisper in settings.",
        });
      }
    } finally {
      setBusy(false);
    }
  }

  async function handlePauseResume() {
    if (demo && !live) {
      setDemoPaused((v) => {
        const next = !v;
        setDemoState(next ? "paused" : "speaking");
        return next;
      });
      return;
    }
    if (snap.state === "paused") await engine.resume();
    else engine.pause();
  }

  async function handleEndAnalyze() {
    if (demo && !live) {
      setStudioEntered(false);
      window.setTimeout(() => setDemo(false), 280);
      return;
    }
    setBusy(true);
    try {
      const text = await engine.stop();
      if (!text.trim()) {
        toast.error("No speech was captured. Check mute, audio source, and transcription.");
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
      void navigate({ to: "/minutes" });
    } finally {
      setBusy(false);
    }
  }

  const recent = meetings
    .slice()
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .slice(0, 4);

  if (live || demo) {
    return (
      <Studio
        snapState={live ? snap.state : demoState}
        sttPaused={live ? snap.sttPaused : false}
        elapsedMs={live ? snap.elapsedMs : demoElapsed}
        level={live ? snap.level : demoLevel}
        transcript={live ? snap.transcript : demoTranscript}
        partial={live ? snap.partial : demoPartial}
        error={live ? snap.error : null}
        audioSource={live ? snap.audioSource : audioSource}
        busy={busy}
        demo={!live && demo}
        entered={live || studioEntered}
        onPauseResume={() => void handlePauseResume()}
        onEnd={() => void handleEndAnalyze()}
        onStartReal={() => void handleStart()}
      />
    );
  }

  return (
    <div className="hero-wash relative mx-auto flex min-h-[calc(100dvh-8rem)] max-w-2xl flex-col items-center justify-center px-2 text-center">
      <p className="text-2xs font-medium tracking-wider text-muted uppercase">
        Overhear the meeting
      </p>
      <h1 className="mt-3 font-display text-4xl font-medium tracking-tight text-fg sm:text-5xl">
        Listen live
      </h1>
      <p className="mt-4 max-w-md text-base text-muted">
        Capture system audio or your mic, transcribe in real time, then turn the transcript into
        structured minutes.
      </p>

      <div className="mt-10 flex w-full max-w-sm flex-col gap-3">
        <div className="grid grid-cols-3 gap-2">
          {SOURCES.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => setAudioSource(s.id)}
              className={cn(
                "flex flex-col items-center gap-1.5 rounded-2xl px-2 py-3 text-center transition-all duration-300 ease-[var(--ease-out)]",
                audioSource === s.id
                  ? "bg-elevated shadow-[var(--shadow-border)] ring-1 ring-fg/10"
                  : "bg-surface/60 hover:bg-elevated/80",
              )}
            >
              {s.id === "mic" ? (
                <Mic className="size-5 text-fg" />
              ) : s.id === "system" ? (
                <Monitor className="size-5 text-fg" />
              ) : (
                <div className="flex -space-x-1">
                  <Mic className="size-4 text-fg" />
                  <Monitor className="size-4 text-fg" />
                </div>
              )}
              <span className="text-xs font-medium text-fg">{s.label}</span>
              <span className="text-2xs text-muted">{s.hint}</span>
            </button>
          ))}
        </div>

        <Button
          size="lg"
          className="h-14 rounded-2xl text-base font-medium"
          disabled={busy}
          onClick={() => void handleStart()}
        >
          {busy ? <Loader2 className="size-5 animate-spin" /> : <Mic className="size-5" />}
          Start listening
        </Button>

        {tourDone ? (
          <button
            type="button"
            className="flex items-center justify-center gap-1.5 text-sm text-muted transition-colors hover:text-fg"
            onClick={() => {
              setDemoPaused(false);
              setDemoElapsed(0);
              setStudioEntered(false);
              setDemo(true);
              requestAnimationFrame(() => setStudioEntered(true));
            }}
          >
            <Sparkles className="size-3.5" />
            Replay studio preview
          </button>
        ) : (
          <p className="text-xs text-subtle">Finish the welcome tour to preview the studio.</p>
        )}

        <button
          type="button"
          className="flex items-center justify-center gap-1.5 text-sm text-muted hover:text-fg"
          onClick={() => setShowSettings((v) => !v)}
        >
          <Settings2 className="size-3.5" />
          Transcription settings
        </button>

        {showSettings ? (
          <SettingsBlock stt={stt} persistStt={persistStt} className="mt-1 text-left" />
        ) : null}
      </div>

      {hydrated && recent.length > 0 ? (
        <div className="mt-16 w-full max-w-md text-left">
          <p className="mb-3 text-2xs font-medium tracking-wider text-muted uppercase">
            Recent sessions
          </p>
          <ul className="flex flex-col gap-2">
            {recent.map((m) => (
              <li key={m.id}>
                <button
                  type="button"
                  className="flex w-full items-center justify-between rounded-xl bg-surface px-4 py-3 text-left shadow-[var(--shadow-border)] transition hover:bg-elevated"
                  onClick={() => {
                    try {
                      sessionStorage.setItem("knowledge-hub.minutes.openId", m.id);
                    } catch {
                      /* ignore */
                    }
                    void navigate({ to: "/minutes" });
                  }}
                >
                  <span className="truncate text-sm font-medium text-fg">{m.title}</span>
                  <span className="shrink-0 text-2xs text-muted">{formatWhen(m.startedAt)}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function Studio({
  snapState,
  sttPaused,
  elapsedMs,
  level,
  transcript,
  partial,
  error,
  audioSource,
  busy,
  demo,
  entered,
  onPauseResume,
  onEnd,
  onStartReal,
}: {
  snapState: LiveListenState;
  sttPaused: boolean;
  elapsedMs: number;
  level: number;
  transcript: string;
  partial: string;
  error: string | null;
  audioSource: AudioSourceMode;
  busy: boolean;
  demo?: boolean;
  entered: boolean;
  onPauseResume: () => void;
  onEnd: () => void;
  onStartReal?: () => void;
}) {
  const speaking = snapState === "speaking";
  const muted = snapState === "likely_muted";
  const [showTranscript, setShowTranscript] = useState(true);
  const [colorPhase, setColorPhase] = useState(0);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const isPaused = snapState === "paused";

  useEffect(() => {
    if (snapState === "paused" || muted) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      // Slow, continuous hue drift
      setColorPhase((p) => (p + dt * 0.1) % 1);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [snapState, muted]);

  useEffect(() => {
    if (transcriptRef.current) {
      transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight;
    }
  }, [transcript, partial]);

  const palette = useMemo(() => {
    const t = colorPhase;
    const h1 = (198 + t * 170) % 360;
    const h2 = (h1 + 38) % 360;
    const h3 = (h1 + 78) % 360;
    const sat = speaking ? 78 : 58;
    const light = speaking ? 62 : 50;
    return {
      c1: `hsl(${h1} ${sat}% ${light}%)`,
      c2: `hsl(${h2} ${sat + 6}% ${light + 6}%)`,
      c3: `hsl(${h3} ${sat}% ${light - 4}%)`,
      glow: `hsl(${h1} 92% 72%)`,
      accent: `hsl(${h2} 88% 68%)`,
    };
  }, [colorPhase, speaking]);

  return (
    <div
      className={cn(
        "ios-studio fixed inset-0 z-50 flex flex-col overflow-hidden transition-all duration-500 ease-[var(--ease-out)]",
        entered ? "opacity-100 scale-100" : "opacity-0 scale-[0.985]",
      )}
    >
      <div
        className="ios-bg-gradient absolute inset-0 transition-[background] duration-700 ease-linear"
        style={{
          background: `
            radial-gradient(ellipse 130% 90% at 18% 8%, ${palette.c1}66 0%, transparent 58%),
            radial-gradient(ellipse 110% 95% at 88% 18%, ${palette.c2}70 0%, transparent 52%),
            radial-gradient(ellipse 95% 75% at 50% 92%, ${palette.c3}75 0%, transparent 58%),
            linear-gradient(165deg, #050508 0%, #0c0c14 42%, #08080f 100%)
          `,
        }}
      />

      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div
          className="ios-blob ios-blob-1"
          style={{ background: `radial-gradient(circle, ${palette.c1}66, transparent 70%)` }}
        />
        <div
          className="ios-blob ios-blob-2"
          style={{ background: `radial-gradient(circle, ${palette.c2}55, transparent 70%)` }}
        />
        <div
          className="ios-blob ios-blob-3"
          style={{ background: `radial-gradient(circle, ${palette.c3}44, transparent 70%)` }}
        />
      </div>

      <div className="relative z-10 flex items-center justify-between px-5 pt-6 pb-2">
        <div className="flex items-center gap-2.5">
          <div
            className={cn(
              "flex size-10 items-center justify-center rounded-full backdrop-blur-xl transition-all duration-500 ease-[var(--ease-out)]",
              muted
                ? "bg-red-500/20 text-red-400"
                : speaking
                  ? "bg-white/18 text-white"
                  : "bg-white/10 text-white/80",
            )}
            style={speaking ? { boxShadow: `0 0 22px ${palette.glow}` } : undefined}
          >
            {muted ? (
              <MicOff className="size-4" />
            ) : audioSource !== "mic" ? (
              <Monitor className="size-4" />
            ) : (
              <Mic className="size-4" />
            )}
          </div>
          <div>
            <p className="text-[15px] font-semibold tracking-tight text-white">
              {demo ? "Live preview" : stateLabel(snapState, sttPaused)}
            </p>
            <p className="font-mono text-xs tabular-nums text-white/55">
              {formatElapsed(elapsedMs)}
            </p>
          </div>
        </div>

        <button
          type="button"
          onClick={() => setShowTranscript((v) => !v)}
          className="flex items-center gap-1.5 rounded-full bg-white/12 px-3.5 py-2 text-xs font-medium text-white/85 backdrop-blur-xl transition-all duration-300 hover:bg-white/18 active:scale-95"
        >
          {showTranscript ? (
            <>
              <EyeOff className="size-3.5" /> Hide text
            </>
          ) : (
            <>
              <Eye className="size-3.5" /> Show text
            </>
          )}
        </button>
      </div>

      <div className="relative z-10 flex min-h-0 flex-1 flex-col items-center justify-center px-2">
        <WaveVisualizer
          level={level}
          speaking={speaking}
          muted={muted}
          paused={isPaused}
          palette={palette}
        />

        {muted && (
          <p className="mt-4 max-w-xs text-center text-sm text-red-300/90">
            We can&apos;t hear the meeting. Unmute or enable “Share audio”.
          </p>
        )}
      </div>

      <div
        className={cn(
          "relative z-10 mx-4 mb-3 overflow-hidden rounded-2xl transition-all duration-500 ease-[var(--ease-out)]",
          showTranscript ? "max-h-44 opacity-100 translate-y-0" : "pointer-events-none max-h-0 opacity-0 translate-y-2",
        )}
      >
        <div
          ref={transcriptRef}
          className="ios-transcript-glass max-h-44 overflow-y-auto px-5 py-4"
        >
          {transcript || partial ? (
            <p className="text-[15px] leading-relaxed text-white/92">
              {transcript}
              {partial ? <span className="text-white/45"> {partial}</span> : null}
            </p>
          ) : (
            <p className="ios-shimmer text-sm">Waiting for speech…</p>
          )}
        </div>
      </div>

      {error ? (
        <p className="relative z-10 mx-5 mb-2 text-center text-sm text-red-300">{error}</p>
      ) : null}

      <div className="relative z-10 mx-4 mb-8 flex flex-wrap items-center justify-center gap-3">
        <button
          type="button"
          disabled={busy}
          onClick={onPauseResume}
          className="ios-control-btn flex h-14 w-14 items-center justify-center rounded-full bg-white/14 text-white backdrop-blur-2xl transition-all duration-300 hover:bg-white/22 active:scale-90 disabled:opacity-50"
        >
          {isPaused ? <Play className="size-6 fill-current" /> : <Pause className="size-6" />}
        </button>

        {demo && onStartReal ? (
          <button
            type="button"
            disabled={busy}
            onClick={onStartReal}
            className="ios-control-btn flex h-16 items-center gap-2.5 rounded-full bg-white px-7 text-[15px] font-semibold text-black shadow-[0_8px_32px_rgba(0,0,0,0.35)] transition-all duration-300 hover:scale-[1.02] active:scale-95 disabled:opacity-60"
          >
            {busy ? <Loader2 className="size-5 animate-spin" /> : <Mic className="size-4" />}
            Start listening
          </button>
        ) : (
          <button
            type="button"
            disabled={busy}
            onClick={onEnd}
            className="ios-control-btn flex h-16 items-center gap-2.5 rounded-full bg-white px-8 text-[15px] font-semibold text-black shadow-[0_8px_32px_rgba(0,0,0,0.35)] transition-all duration-300 hover:scale-[1.02] active:scale-95 disabled:opacity-60"
          >
            {busy ? (
              <Loader2 className="size-5 animate-spin" />
            ) : (
              <Square className="size-4 fill-current" />
            )}
            End & analyse
          </button>
        )}

        {demo ? (
          <button
            type="button"
            onClick={onEnd}
            className="ios-control-btn flex h-14 items-center rounded-full bg-white/12 px-5 text-sm font-medium text-white/85 backdrop-blur-2xl transition-all duration-300 hover:bg-white/18"
          >
            Close
          </button>
        ) : null}
      </div>
    </div>
  );
}

function WaveVisualizer({
  level,
  speaking,
  muted,
  paused,
  palette,
}: {
  level: number;
  speaking: boolean;
  muted: boolean;
  paused: boolean;
  palette: { c1: string; c2: string; c3: string; glow: string; accent: string };
}) {
  const bars = 36;
  const amp = muted ? 0.12 : paused ? 0.2 : Math.max(0.45, Math.min(1, 0.4 + level * 1.4));

  return (
    <div
      className="relative flex w-full max-w-3xl items-center justify-center"
      style={{ height: "min(52vh, 420px)" }}
    >
      <div
        className="absolute inset-0 rounded-full opacity-90 blur-3xl transition-transform duration-700 ease-[var(--ease-out)]"
        style={{
          background: `radial-gradient(ellipse 80% 55% at 50% 50%, ${palette.glow}aa, transparent 70%)`,
          transform: speaking ? "scale(1.28)" : "scale(0.95)",
        }}
      />

      <div className="relative z-10 flex h-full w-full items-stretch justify-center gap-[5px] px-5">
        {Array.from({ length: bars }, (_, i) => {
          const center = bars / 2;
          const dist = Math.abs(i - center) / center;
          const envelope = Math.cos(dist * Math.PI * 0.5) ** 1.05;
          const pct = 28 + envelope * amp * 68;
          const delay = (i % 10) * 40;

          return (
            <div
              key={i}
              className="flex h-full items-center"
              style={{ width: i % 4 === 0 ? 8 : 6 }}
            >
              <span
                className={cn("ios-wave-bar rounded-full", muted && "opacity-40")}
                style={{
                  width: "100%",
                  height: `${pct}%`,
                  background: muted
                    ? "rgba(248,113,113,0.55)"
                    : `linear-gradient(180deg, ${palette.accent}, ${palette.c1} 50%, ${palette.c3})`,
                  boxShadow: speaking ? `0 0 18px ${palette.glow}` : `0 0 8px ${palette.c1}88`,
                  animation:
                    speaking && !paused
                      ? `ios-wave-pulse 1.2s cubic-bezier(0.45, 0, 0.55, 1) ${delay}ms infinite`
                      : undefined,
                }}
              />
            </div>
          );
        })}
      </div>

      <svg
        className="pointer-events-none absolute inset-0 h-full w-full opacity-35"
        viewBox="0 0 400 200"
        preserveAspectRatio="none"
      >
        <path
          className="ios-svg-wave"
          d={buildWavePath(400, 200, amp * 44, 0)}
          fill="none"
          stroke={palette.c1}
          strokeWidth="2.5"
          strokeLinecap="round"
        />
        <path
          className="ios-svg-wave ios-svg-wave-delay"
          d={buildWavePath(400, 200, amp * 30, 1.2)}
          fill="none"
          stroke={palette.c2}
          strokeWidth="1.8"
          strokeLinecap="round"
          opacity="0.75"
        />
      </svg>
    </div>
  );
}

function buildWavePath(w: number, h: number, amp: number, phase: number) {
  const mid = h / 2;
  let d = `M 0 ${mid}`;
  const steps = 32;
  for (let i = 0; i <= steps; i++) {
    const x = (i / steps) * w;
    const y = mid + Math.sin((i / steps) * Math.PI * 3 + phase) * amp;
    d += ` L ${x.toFixed(1)} ${y.toFixed(1)}`;
  }
  return d;
}

function SettingsBlock({
  stt,
  persistStt,
  className,
}: {
  stt: SttProvidersState;
  persistStt: (next: SttProvidersState) => void;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col gap-3 rounded-xl bg-surface p-4 shadow-[var(--shadow-border)]",
        className,
      )}
    >
      <div className="flex flex-col gap-1.5">
        <Label>Speech-to-text</Label>
        <select
          className="h-11 rounded-md bg-elevated px-3 text-sm text-fg shadow-[var(--shadow-border)]"
          value={stt.activeId}
          onChange={(e) => persistStt({ ...stt, activeId: e.target.value as SttProviderId })}
        >
          <option value="browser">Browser (free)</option>
          <option value="deepgram">Deepgram</option>
          <option value="whisper">Whisper (OpenAI-compatible)</option>
        </select>
      </div>
      {stt.activeId === "deepgram" && (
        <>
          <div className="flex flex-col gap-1.5">
            <Label>Deepgram API key</Label>
            <Input
              type="password"
              value={stt.deepgramKey}
              placeholder="nova-3 live key"
              onChange={(e) => persistStt({ ...stt, deepgramKey: e.target.value })}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>Model</Label>
            <Input
              value={stt.deepgramModel ?? "nova-3"}
              onChange={(e) => persistStt({ ...stt, deepgramModel: e.target.value })}
            />
          </div>
        </>
      )}
      {stt.activeId === "whisper" && (
        <>
          <div className="flex flex-col gap-1.5">
            <Label>Whisper API key</Label>
            <Input
              type="password"
              value={stt.whisperKey}
              onChange={(e) => persistStt({ ...stt, whisperKey: e.target.value })}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>Base URL</Label>
            <Input
              value={stt.whisperBaseUrl}
              placeholder={DEFAULT_STT.whisperBaseUrl}
              onChange={(e) => persistStt({ ...stt, whisperBaseUrl: e.target.value })}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>Model</Label>
            <Input
              value={stt.whisperModel}
              onChange={(e) => persistStt({ ...stt, whisperModel: e.target.value })}
            />
          </div>
        </>
      )}
      <label className="flex items-center gap-2 text-xs text-fg">
        <input
          type="checkbox"
          checked={stt.pauseWhileMuted}
          onChange={(e) => persistStt({ ...stt, pauseWhileMuted: e.target.checked })}
        />
        Pause transcription while muted
      </label>
    </div>
  );
}
