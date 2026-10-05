/**
 * Speech-to-text provider settings for live sessions.
 * Keys stay in localStorage on this device, with optional Vite env fallback:
 *   VITE_DEEPGRAM_API_KEY
 *   VITE_WHISPER_API_KEY
 */

export const STT_PROVIDER_IDS = ["browser", "deepgram", "whisper"] as const;
export type SttProviderId = (typeof STT_PROVIDER_IDS)[number];

export type SttProvidersState = {
  activeId: SttProviderId;
  deepgramKey: string;
  whisperKey: string;
  whisperBaseUrl: string;
  whisperModel: string;
  /** Deepgram model id — matches their streaming samples (e.g. nova-3). */
  deepgramModel: string;
  pauseWhileMuted: boolean;
};

const STORAGE_KEY = "knowledge-hub.stt-providers.v1";

export const DEFAULT_STT: SttProvidersState = {
  activeId: "deepgram",
  deepgramKey: "",
  whisperKey: "",
  whisperBaseUrl: "https://api.openai.com/v1",
  whisperModel: "whisper-1",
  deepgramModel: "nova-3",
  pauseWhileMuted: true,
};

function envDeepgramKey(): string {
  try {
    const v = import.meta.env?.VITE_DEEPGRAM_API_KEY;
    return typeof v === "string" ? v.trim() : "";
  } catch {
    return "";
  }
}

function envWhisperKey(): string {
  try {
    const v = import.meta.env?.VITE_WHISPER_API_KEY;
    return typeof v === "string" ? v.trim() : "";
  } catch {
    return "";
  }
}

export function loadSttProviders(): SttProvidersState {
  const envDg = envDeepgramKey();
  const envWh = envWhisperKey();
  if (typeof window === "undefined") {
    return {
      ...DEFAULT_STT,
      deepgramKey: envDg,
      whisperKey: envWh,
    };
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return {
        ...DEFAULT_STT,
        deepgramKey: envDg,
        whisperKey: envWh,
        activeId: envDg ? "deepgram" : DEFAULT_STT.activeId,
      };
    }
    const v = JSON.parse(raw) as Partial<SttProvidersState>;
    const id = STT_PROVIDER_IDS.includes(v.activeId as SttProviderId)
      ? (v.activeId as SttProviderId)
      : "deepgram";
    // Prefer UI-saved key; fall back to env so deploy can inject without the form
    const deepgramKey =
      (typeof v.deepgramKey === "string" && v.deepgramKey.trim()) || envDg || "";
    const whisperKey =
      (typeof v.whisperKey === "string" && v.whisperKey.trim()) || envWh || "";
    return {
      activeId: id,
      deepgramKey,
      whisperKey,
      whisperBaseUrl:
        typeof v.whisperBaseUrl === "string" && v.whisperBaseUrl.trim()
          ? v.whisperBaseUrl.trim().replace(/\/+$/, "")
          : DEFAULT_STT.whisperBaseUrl,
      whisperModel:
        typeof v.whisperModel === "string" && v.whisperModel.trim()
          ? v.whisperModel.trim()
          : DEFAULT_STT.whisperModel,
      deepgramModel:
        typeof v.deepgramModel === "string" && v.deepgramModel.trim()
          ? v.deepgramModel.trim()
          : DEFAULT_STT.deepgramModel,
      pauseWhileMuted:
        typeof v.pauseWhileMuted === "boolean" ? v.pauseWhileMuted : true,
    };
  } catch {
    return { ...DEFAULT_STT, deepgramKey: envDg, whisperKey: envWh };
  }
}

export function saveSttProviders(state: SttProvidersState): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

/** Encode mono PCM float samples (-1..1) as a 16-bit WAV Blob (Whisper path). */
export function encodeWavMono(samples: Float32Array, sampleRate: number): Blob {
  const numSamples = samples.length;
  const buffer = new ArrayBuffer(44 + numSamples * 2);
  const view = new DataView(buffer);
  const writeStr = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + numSamples * 2, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, numSamples * 2, true);
  let offset = 44;
  for (let i = 0; i < numSamples; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]!));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }
  return new Blob([buffer], { type: "audio/wav" });
}

export async function transcribeWhisper(
  blob: Blob,
  opts: { apiKey: string; baseUrl: string; model: string },
): Promise<string> {
  const form = new FormData();
  const mime = blob.type || "audio/wav";
  const ext = mime.includes("wav")
    ? "wav"
    : mime.includes("mp4") || mime.includes("m4a")
      ? "m4a"
      : "webm";
  form.append("file", blob, `chunk.${ext}`);
  form.append("model", opts.model);
  form.append("response_format", "text");
  const res = await fetch(`${opts.baseUrl.replace(/\/+$/, "")}/audio/transcriptions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${opts.apiKey}` },
    body: form,
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Whisper ${res.status}: ${t.slice(0, 220)}`);
  }
  return (await res.text()).trim();
}

/**
 * Open a Deepgram Listen v1 live WebSocket (same idea as their Python sample:
 * connect → stream media → Results messages with transcript).
 *
 * Auth uses the WebSocket subprotocol pair `["token", apiKey]` (browser-safe).
 */
export function openDeepgramLiveSocket(opts: {
  apiKey: string;
  model?: string;
  language?: string;
}): WebSocket {
  const params = new URLSearchParams({
    model: opts.model || "nova-3",
    language: opts.language || "en",
    punctuate: "true",
    interim_results: "true",
    smart_format: "true",
    encoding: "linear16",
    sample_rate: "16000",
    channels: "1",
  });
  const url = `wss://api.deepgram.com/v1/listen?${params.toString()}`;
  return new WebSocket(url, ["token", opts.apiKey]);
}
