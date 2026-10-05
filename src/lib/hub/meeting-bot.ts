/**
 * Unified meeting-bot API fallback (Path B).
 *
 * When native Zoom/Teams/Meet APIs are unavailable or insufficient,
 * send a bot to the meeting URL via a third-party Meeting Bot API.
 *
 * Supported provider shapes (OpenAI-style / simple REST):
 *   - Skribby     (~$0.35/hr)
 *   - Meeting BaaS
 *   - Recall.ai
 *   - MeetStream
 *   - Custom base URL
 *
 * Flow:
 *   1. createBot({ meetingUrl, botName, webhookUrl })
 *   2. Provider joins call, records + transcribes
 *   3. Provider POSTs to your webhook when done
 *   4. parseBotWebhook → RemoteMeeting → ingestRemoteMeetings
 */
import type { RemoteMeeting } from "./types.ts";

export const MEETING_BOT_PROVIDERS = [
  "skribby",
  "meetingbaas",
  "recall",
  "meetstream",
  "custom",
] as const;

export type MeetingBotProviderId = (typeof MEETING_BOT_PROVIDERS)[number];

export type MeetingBotConfig = {
  providerId: MeetingBotProviderId;
  apiKey: string;
  /** Base URL override for custom / self-hosted. */
  baseUrl?: string;
  /** Display name the bot shows in the participant list. */
  botName?: string;
};

const DEFAULT_BASE: Record<MeetingBotProviderId, string> = {
  skribby: "https://api.skribby.io/v1",
  meetingbaas: "https://api.meetingbaas.com",
  recall: "https://us-west-2.recall.ai/api/v1",
  meetstream: "https://api.meetstream.ai/api/v1",
  custom: "",
};

export type CreateBotInput = {
  meetingUrl: string;
  webhookUrl: string;
  botName?: string;
  /** Join at a specific time (ISO). Omit to join immediately. */
  joinAt?: string;
};

export type CreateBotResult =
  | { ok: true; botId: string; providerId: MeetingBotProviderId }
  | { ok: false; error: string };

/**
 * Dispatch a bot to a meeting URL.
 * Provider-specific payload differences are normalized here.
 */
export async function createMeetingBot(
  config: MeetingBotConfig,
  input: CreateBotInput,
): Promise<CreateBotResult> {
  const base = (config.baseUrl?.replace(/\/+$/, "") || DEFAULT_BASE[config.providerId]).replace(
    /\/+$/,
    "",
  );
  if (!base) {
    return { ok: false, error: "Custom provider requires a baseUrl" };
  }
  if (!config.apiKey.trim()) {
    return { ok: false, error: "Meeting bot API key is required" };
  }
  if (!input.meetingUrl.trim()) {
    return { ok: false, error: "meetingUrl is required" };
  }

  const botName = input.botName || config.botName || "Knowledge Hub Notes";

  try {
    if (config.providerId === "recall") {
      const res = await fetch(`${base}/bot/`, {
        method: "POST",
        headers: {
          Authorization: `Token ${config.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          meeting_url: input.meetingUrl,
          bot_name: botName,
          transcription_options: { provider: "default" },
          real_time_transcription: { destination_url: input.webhookUrl },
        }),
        signal: AbortSignal.timeout(20000),
      });
      if (!res.ok) {
        const t = await res.text().catch(() => "");
        return { ok: false, error: `Recall ${res.status}: ${t.slice(0, 200)}` };
      }
      const body = (await res.json()) as { id?: string };
      return { ok: true, botId: String(body.id ?? ""), providerId: "recall" };
    }

    // Generic shape used by Skribby / Meeting BaaS / MeetStream / custom
    const res = await fetch(`${base}/bots`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        meeting_url: input.meetingUrl,
        bot_name: botName,
        webhook_url: input.webhookUrl,
        join_at: input.joinAt,
        recording: true,
        transcription: true,
      }),
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      return { ok: false, error: `Bot API ${res.status}: ${t.slice(0, 200)}` };
    }
    const body = (await res.json()) as { id?: string; bot_id?: string };
    return {
      ok: true,
      botId: String(body.id ?? body.bot_id ?? ""),
      providerId: config.providerId,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Bot create failed";
    return { ok: false, error: msg.slice(0, 300) };
  }
}

/**
 * Normalize a provider webhook payload into a RemoteMeeting.
 * Handles common fields across Skribby / Recall / Meeting BaaS / MeetStream.
 */
export function parseBotWebhook(payload: unknown): RemoteMeeting | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  const data =
    p.data && typeof p.data === "object" ? (p.data as Record<string, unknown>) : p;

  const title =
    str(data.topic) ||
    str(data.title) ||
    str(data.meeting_title) ||
    str(p.topic) ||
    "Meeting bot recording";

  const startedAt =
    str(data.start_time) ||
    str(data.started_at) ||
    str(data.join_at) ||
    new Date().toISOString();

  const transcript =
    str(data.transcript) ||
    str(data.transcript_text) ||
    flattenTranscriptArray(data.utterances ?? data.segments ?? data.transcript_segments) ||
    "";

  if (!transcript && !str(data.summary)) return null;

  const attendees = Array.isArray(data.participants)
    ? data.participants
        .map((x) => {
          if (typeof x === "string") return x;
          if (x && typeof x === "object") {
            const o = x as Record<string, unknown>;
            return str(o.name) || str(o.display_name) || str(o.email);
          }
          return "";
        })
        .filter(Boolean)
        .slice(0, 16)
    : [];

  const botId = str(data.bot_id) || str(data.id) || str(p.bot_id) || "bot";

  return {
    title,
    startedAt,
    attendees,
    summary: str(data.summary) || str(data.meeting_summary) || "",
    decisions: [],
    actionItems: [],
    transcript,
    sourceFile: `bot-${botId.replace(/[^a-zA-Z0-9_-]/g, "_")}.txt`,
  };
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function flattenTranscriptArray(v: unknown): string {
  if (!Array.isArray(v)) return "";
  return v
    .map((item) => {
      if (typeof item === "string") return item;
      if (item && typeof item === "object") {
        const o = item as Record<string, unknown>;
        const speaker = str(o.speaker) || str(o.speaker_name) || str(o.participant);
        const text = str(o.text) || str(o.words) || str(o.content);
        return speaker ? `${speaker}: ${text}` : text;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}
