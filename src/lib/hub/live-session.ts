/**
 * Live-session engine: mic and/or system/tab audio, level meter, energy VAD,
 * mute/silence states, and STT via browser Web Speech, Deepgram live WS, or Whisper.
 *
 * Deepgram path mirrors their official streaming sample:
 *   connect to listen.v1 → send_media (PCM) → Results transcripts
 * but runs in the browser over WebSocket instead of Python.
 */

import {
  encodeWavMono,
  loadSttProviders,
  openDeepgramLiveSocket,
  transcribeWhisper,
  type SttProviderId,
} from "./stt-providers.ts";

export type LiveListenState =
  | "idle"
  | "requesting"
  | "listening"
  | "speaking"
  | "silent"
  | "likely_muted"
  | "paused"
  | "error";

export type AudioSourceMode = "mic" | "system" | "both";

export type LiveSessionSnapshot = {
  state: LiveListenState;
  level: number;
  elapsedMs: number;
  transcript: string;
  partial: string;
  error: string | null;
  speechSupported: boolean;
  sttProvider: SttProviderId;
  audioSource: AudioSourceMode;
  sttPaused: boolean;
};

type Listener = (snap: LiveSessionSnapshot) => void;

const SILENCE_MS = 1600;
const MUTE_MS = 6000;
const SPEAK_THRESHOLD = 0.04;
const MUTE_THRESHOLD = 0.012;
const CHUNK_SECONDS = 6;
const TARGET_RATE = 16000;

function speechRecognitionCtor(): (new () => SpeechRecognition) | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: new () => SpeechRecognition;
    webkitSpeechRecognition?: new () => SpeechRecognition;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function isSpeechRecognitionSupported(): boolean {
  return speechRecognitionCtor() !== null;
}

function downsample(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate) return input;
  const ratio = fromRate / toRate;
  const length = Math.max(1, Math.floor(input.length / ratio));
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    let n = 0;
    for (let j = start; j < end; j++) {
      sum += input[j]!;
      n++;
    }
    out[i] = n ? sum / n : 0;
  }
  return out;
}

/** Float32 mono -1..1 → Int16 LE ArrayBuffer for Deepgram linear16. */
function floatTo16BitPCM(samples: Float32Array): ArrayBuffer {
  const buf = new ArrayBuffer(samples.length * 2);
  const view = new DataView(buf);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]!));
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buf;
}

export class LiveSessionEngine {
  private listeners = new Set<Listener>();
  private stream: MediaStream | null = null;
  private audioCtx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private processor: ScriptProcessorNode | null = null;
  private raf = 0;
  private recognition: SpeechRecognition | null = null;
  private dgSocket: WebSocket | null = null;
  private state: LiveListenState = "idle";
  private level = 0;
  private elapsedMs = 0;
  private runningSince = 0;
  private pausedAccum = 0;
  private lastVoiceAt = 0;
  private transcriptParts: string[] = [];
  /** Timestamped `[mm:ss] Speaker: text` lines, the format the meeting parser ingests. */
  private transcriptLines: string[] = [];
  private partial = "";
  private error: string | null = null;
  private wantRunning = false;
  private sttPaused = false;
  private audioSource: AudioSourceMode = "mic";
  private sttProvider: SttProviderId = "browser";
  private transcribeBusy = false;
  private pcmChunks: Float32Array[] = [];
  private pcmSamples = 0;
  private mode: "none" | "browser" | "deepgram" | "whisper" = "none";
  private mixCtx: AudioContext | null = null;

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    fn(this.snapshot());
    return () => this.listeners.delete(fn);
  }

  snapshot(): LiveSessionSnapshot {
    const stt = loadSttProviders();
    return {
      state: this.state,
      level: this.level,
      elapsedMs: this.computeElapsed(),
      transcript: this.transcriptParts.join(" ").trim(),
      partial: this.partial,
      error: this.error,
      speechSupported: isSpeechRecognitionSupported(),
      sttProvider: this.sttProvider || stt.activeId,
      audioSource: this.audioSource,
      sttPaused: this.sttPaused,
    };
  }

  async start(opts?: { audioSource?: AudioSourceMode }): Promise<void> {
    if (this.isActive()) return;
    this.wantRunning = true;
    this.error = null;
    this.sttPaused = false;
    this.audioSource = opts?.audioSource ?? "mic";
    this.sttProvider = loadSttProviders().activeId;
    this.setState("requesting");

    try {
      this.stream = await this.acquireStream(this.audioSource);
    } catch (err) {
      this.error = err instanceof Error ? err.message : "Could not access audio.";
      this.setState("error");
      this.wantRunning = false;
      return;
    }

    if (!this.stream.getAudioTracks().length) {
      this.error = "No audio track in the selected source.";
      this.setState("error");
      this.wantRunning = false;
      return;
    }

    this.audioCtx = new AudioContext();
    if (this.audioCtx.state === "suspended") {
      await this.audioCtx.resume().catch(() => undefined);
    }

    this.sourceNode = this.audioCtx.createMediaStreamSource(this.stream);
    this.analyser = this.audioCtx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.analyser.smoothingTimeConstant = 0.7;
    this.sourceNode.connect(this.analyser);
    const gain = this.audioCtx.createGain();
    gain.gain.value = 0;
    this.sourceNode.connect(gain);
    gain.connect(this.audioCtx.destination);

    this.runningSince = performance.now();
    this.pausedAccum = 0;
    this.lastVoiceAt = this.runningSince;
    this.transcriptParts = [];
    this.transcriptLines = [];
    this.partial = "";
    this.pcmChunks = [];
    this.pcmSamples = 0;
    this.setState("listening");
    this.startMeter();
    this.startStt();
  }

  private pushFinal(text: string): void {
    const t = text.trim();
    if (!t) return;
    this.transcriptParts.push(t);
    const sec = Math.floor(this.computeElapsed() / 1000);
    const mm = String(Math.floor(sec / 60)).padStart(2, "0");
    const ss = String(sec % 60).padStart(2, "0");
    this.transcriptLines.push(`[${mm}:${ss}] Speaker: ${t}`);
  }

  pause(): void {
    if (!this.isActive()) return;
    this.wantRunning = false;
    this.pausedAccum += performance.now() - this.runningSince;
    this.pauseStt();
    this.setState("paused");
  }

  async resume(): Promise<void> {
    if (this.state !== "paused") return;
    this.wantRunning = true;
    this.runningSince = performance.now();
    this.lastVoiceAt = this.runningSince;
    this.sttPaused = false;
    if (this.audioCtx?.state === "suspended") {
      await this.audioCtx.resume().catch(() => undefined);
    }
    this.setState("listening");
    this.startStt();
  }

  async stop(): Promise<string> {
    this.wantRunning = false;
    if (this.mode === "whisper" && this.pcmSamples > TARGET_RATE * 0.4) {
      await this.flushWhisperChunk();
    }
    this.pauseStt();
    this.stopMeter();
    this.teardownAudioGraph();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    void this.mixCtx?.close();
    this.mixCtx = null;
    const text = this.transcriptLines.join("\n").trim();
    this.setState("idle");
    this.level = 0;
    this.partial = "";
    this.sttPaused = false;
    this.mode = "none";
    this.emit();
    return text;
  }

  private teardownAudioGraph() {
    try {
      if (this.processor) {
        this.processor.onaudioprocess = null;
        this.processor.disconnect();
      }
    } catch { /* ignore */ }
    this.processor = null;
    try { this.sourceNode?.disconnect(); } catch { /* ignore */ }
    this.sourceNode = null;
    this.analyser = null;
    void this.audioCtx?.close();
    this.audioCtx = null;
  }

  private async acquireStream(mode: AudioSourceMode): Promise<MediaStream> {
    if (mode === "mic") {
      return navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
        video: false,
      });
    }

    const display = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 1, width: 16, height: 16 },
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1,
      },
    } as DisplayMediaStreamOptions);

    if (display.getAudioTracks().length === 0) {
      display.getTracks().forEach((t) => t.stop());
      throw new Error(
        'No system/tab audio. In the share dialog, choose a Chrome tab and turn on "Share audio".',
      );
    }
    for (const v of display.getVideoTracks()) v.enabled = false;
    if (mode === "system") return display;

    const mic = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      },
      video: false,
    });
    this.mixCtx = new AudioContext();
    const dest = this.mixCtx.createMediaStreamDestination();
    this.mixCtx.createMediaStreamSource(display).connect(dest);
    this.mixCtx.createMediaStreamSource(mic).connect(dest);
    const mixed = dest.stream;
    mixed.getAudioTracks()[0]?.addEventListener("ended", () => {
      mic.getTracks().forEach((t) => t.stop());
      display.getTracks().forEach((t) => t.stop());
    });
    return mixed;
  }

  private isActive(): boolean {
    return (
      this.state === "listening" ||
      this.state === "speaking" ||
      this.state === "silent" ||
      this.state === "likely_muted"
    );
  }

  private computeElapsed(): number {
    if (this.state === "idle" || this.state === "requesting" || this.state === "error") {
      return this.elapsedMs;
    }
    if (this.state === "paused") return this.pausedAccum;
    return this.pausedAccum + (performance.now() - this.runningSince);
  }

  private setState(s: LiveListenState) {
    this.state = s;
    this.emit();
  }

  private emit() {
    this.elapsedMs = this.computeElapsed();
    const snap = this.snapshot();
    for (const fn of this.listeners) fn(snap);
  }

  private startMeter() {
    const tick = () => {
      if (!this.analyser || this.state === "paused" || this.state === "idle") {
        this.raf = 0;
        return;
      }
      const data = new Uint8Array(this.analyser.fftSize);
      this.analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) {
        const v = (data[i]! - 128) / 128;
        sum += v * v;
      }
      this.level = this.level * 0.7 + Math.sqrt(sum / data.length) * 0.3;

      const now = performance.now();
      if (this.level >= SPEAK_THRESHOLD) {
        this.lastVoiceAt = now;
        if (this.state !== "speaking") this.setState("speaking");
        else this.emit();
      } else {
        const quietFor = now - this.lastVoiceAt;
        if (this.level < MUTE_THRESHOLD && quietFor >= MUTE_MS) {
          if (this.state !== "likely_muted") this.setState("likely_muted");
          else this.emit();
        } else if (quietFor >= SILENCE_MS) {
          if (this.state !== "silent") this.setState("silent");
          else this.emit();
        } else if (this.state === "speaking") {
          this.setState("listening");
        } else {
          this.emit();
        }
      }

      const cfg = loadSttProviders();
      if (cfg.pauseWhileMuted && this.wantRunning && this.isActive()) {
        if (this.state === "likely_muted" && !this.sttPaused) {
          this.pauseStt();
          this.sttPaused = true;
          this.emit();
        } else if (
          this.sttPaused &&
          this.level >= SPEAK_THRESHOLD &&
          (this.state === "speaking" || this.state === "listening")
        ) {
          this.sttPaused = false;
          this.startStt();
          this.emit();
        }
      }

      if (this.stream?.getAudioTracks()[0]?.readyState === "ended") {
        this.error = "Audio source ended.";
        this.setState("error");
        return;
      }
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  private stopMeter() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  private startStt() {
    if (this.sttPaused || !this.wantRunning) return;
    const cfg = loadSttProviders();
    this.sttProvider = cfg.activeId;

    if (cfg.activeId === "browser") {
      this.mode = "browser";
      this.stopDeepgram();
      this.stopPcmCapture();
      this.startRecognition();
      return;
    }

    if (cfg.activeId === "deepgram") {
      if (!cfg.deepgramKey.trim()) {
        this.error =
          "Deepgram API key missing. Set VITE_DEEPGRAM_API_KEY in .env or paste it in session settings.";
        this.emit();
        return;
      }
      this.mode = "deepgram";
      this.stopRecognition();
      this.startDeepgramLive(cfg.deepgramKey, cfg.deepgramModel || "nova-3");
      return;
    }

    // whisper
    if (!cfg.whisperKey.trim()) {
      this.error = "Whisper API key missing. Paste it in session settings.";
      this.emit();
      return;
    }
    this.mode = "whisper";
    this.stopRecognition();
    this.stopDeepgram();
    this.startPcmCaptureForWhisper();
  }

  private pauseStt() {
    this.stopRecognition();
    this.stopDeepgram();
    if (this.mode === "whisper" && this.pcmSamples > 0) {
      void this.flushWhisperChunk();
    }
    this.stopPcmCapture();
  }

  // ── Browser Web Speech ───────────────────────────────────────────────

  private startRecognition() {
    const Ctor = speechRecognitionCtor();
    if (!Ctor) {
      this.error =
        "Browser speech recognition unavailable. Switch STT to Deepgram.";
      this.emit();
      return;
    }
    this.stopRecognition();
    const rec = new Ctor();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = navigator.language || "en-US";
    rec.onresult = (event: SpeechRecognitionEvent) => {
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (!result) continue;
        const text = result[0]?.transcript?.trim() ?? "";
        if (!text) continue;
        if (result.isFinal) {
          this.pushFinal(text);
          this.partial = "";
        } else {
          interim = text;
        }
      }
      if (interim) this.partial = interim;
      this.emit();
    };
    rec.onerror = (event: SpeechRecognitionErrorEvent) => {
      if (event.error === "not-allowed" || event.error === "audio-capture") {
        this.error = `Speech recognition: ${event.error}`;
        this.setState("error");
      }
    };
    rec.onend = () => {
      if (this.wantRunning && this.isActive() && !this.sttPaused && this.mode === "browser") {
        try { rec.start(); } catch { /* ignore */ }
      }
    };
    try {
      rec.start();
      this.recognition = rec;
    } catch {
      this.error = "Could not start browser speech recognition.";
      this.emit();
    }
  }

  private stopRecognition() {
    if (!this.recognition) return;
    try {
      this.recognition.onend = null;
      this.recognition.stop();
    } catch { /* ignore */ }
    this.recognition = null;
  }

  // ── Deepgram live WebSocket (like their Python sample) ───────────────

  private startDeepgramLive(apiKey: string, model: string) {
    this.stopDeepgram();
    let socket: WebSocket;
    try {
      socket = openDeepgramLiveSocket({ apiKey, model, language: "en" });
    } catch (err) {
      this.error = err instanceof Error ? err.message : "Deepgram connect failed";
      this.emit();
      return;
    }
    this.dgSocket = socket;

    socket.addEventListener("open", () => {
      this.error = null;
      this.partial = "";
      this.emit();
      this.startPcmCaptureForDeepgram();
    });

    socket.addEventListener("message", (ev) => {
      try {
        const msg = JSON.parse(String(ev.data)) as {
          type?: string;
          is_final?: boolean;
          channel?: { alternatives?: { transcript?: string }[] };
        };
        // Deepgram live: type "Results" (same as Python sample)
        if (msg.type && msg.type !== "Results") return;
        const transcript = msg.channel?.alternatives?.[0]?.transcript?.trim() ?? "";
        if (!transcript) return;
        if (msg.is_final) {
          this.pushFinal(transcript);
          this.partial = "";
        } else {
          this.partial = transcript;
        }
        this.emit();
      } catch {
        /* ignore non-JSON keepalives */
      }
    });

    socket.addEventListener("error", () => {
      this.error =
        "Deepgram WebSocket error (check API key, model, and network).";
      this.emit();
    });

    socket.addEventListener("close", (ev) => {
      this.stopPcmCapture();
      if (this.wantRunning && this.mode === "deepgram" && !this.sttPaused) {
        this.error = `Deepgram closed (${ev.code}). ${ev.reason || "Re-check API key."}`;
        this.emit();
      }
    });
  }

  private stopDeepgram() {
    this.stopPcmCapture();
    if (this.dgSocket) {
      try {
        if (this.dgSocket.readyState === WebSocket.OPEN) {
          // Graceful finish so Deepgram flushes final results
          this.dgSocket.send(JSON.stringify({ type: "CloseStream" }));
        }
        this.dgSocket.close();
      } catch { /* ignore */ }
      this.dgSocket = null;
    }
  }

  private startPcmCaptureForDeepgram() {
    if (!this.audioCtx || !this.sourceNode) return;
    this.stopPcmCapture();
    const bufferSize = 4096;
    const processor = this.audioCtx.createScriptProcessor(bufferSize, 1, 1);
    processor.onaudioprocess = (ev) => {
      if (!this.wantRunning || this.sttPaused || this.mode !== "deepgram") return;
      const socket = this.dgSocket;
      if (!socket || socket.readyState !== WebSocket.OPEN) return;
      const input = ev.inputBuffer.getChannelData(0);
      const down = downsample(input, this.audioCtx!.sampleRate, TARGET_RATE);
      socket.send(floatTo16BitPCM(down));
    };
    this.sourceNode.connect(processor);
    const mute = this.audioCtx.createGain();
    mute.gain.value = 0;
    processor.connect(mute);
    mute.connect(this.audioCtx.destination);
    this.processor = processor;
  }

  // ── Whisper (complete WAV chunks — not Deepgram) ─────────────────────

  private startPcmCaptureForWhisper() {
    if (!this.audioCtx || !this.sourceNode) return;
    this.stopPcmCapture();
    this.pcmChunks = [];
    this.pcmSamples = 0;
    const bufferSize = 4096;
    const processor = this.audioCtx.createScriptProcessor(bufferSize, 1, 1);
    processor.onaudioprocess = (ev) => {
      if (!this.wantRunning || this.sttPaused || this.mode !== "whisper") return;
      const input = ev.inputBuffer.getChannelData(0);
      const copy = new Float32Array(input.length);
      copy.set(input);
      this.pcmChunks.push(copy);
      this.pcmSamples += copy.length;
      const need = Math.floor(this.audioCtx!.sampleRate * CHUNK_SECONDS);
      if (this.pcmSamples >= need && !this.transcribeBusy) {
        void this.flushWhisperChunk();
      }
    };
    this.sourceNode.connect(processor);
    const mute = this.audioCtx.createGain();
    mute.gain.value = 0;
    processor.connect(mute);
    mute.connect(this.audioCtx.destination);
    this.processor = processor;
  }

  private stopPcmCapture() {
    if (!this.processor) return;
    try {
      this.processor.onaudioprocess = null;
      this.processor.disconnect();
    } catch { /* ignore */ }
    this.processor = null;
  }

  private async flushWhisperChunk(): Promise<void> {
    if (this.transcribeBusy || this.pcmSamples === 0 || !this.audioCtx) return;
    this.transcribeBusy = true;
    const rate = this.audioCtx.sampleRate;
    const chunks = this.pcmChunks;
    const total = this.pcmSamples;
    this.pcmChunks = [];
    this.pcmSamples = 0;
    try {
      const merged = new Float32Array(total);
      let off = 0;
      for (const c of chunks) {
        merged.set(c, off);
        off += c.length;
      }
      const down = downsample(merged, rate, TARGET_RATE);
      let energy = 0;
      for (let i = 0; i < down.length; i += 64) energy += Math.abs(down[i]!);
      if (energy / (down.length / 64) < 0.005) return;
      const wav = encodeWavMono(down, TARGET_RATE);
      this.partial = "Transcribing…";
      this.emit();
      const cfg = loadSttProviders();
      const text = await transcribeWhisper(wav, {
        apiKey: cfg.whisperKey,
        baseUrl: cfg.whisperBaseUrl,
        model: cfg.whisperModel,
      });
      if (text) this.pushFinal(text);
      this.partial = "";
      this.error = null;
      this.emit();
    } catch (err) {
      this.partial = "";
      this.error = err instanceof Error ? err.message : "Transcription failed";
      this.emit();
    } finally {
      this.transcribeBusy = false;
    }
  }
}

let engine: LiveSessionEngine | null = null;

export function getLiveSessionEngine(): LiveSessionEngine {
  if (!engine) engine = new LiveSessionEngine();
  return engine;
}
