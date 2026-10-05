/**
 * Zoom webhook handler helpers for post-meeting transcript ingestion.
 *
 * Subscribe (Webhook-only or OAuth app) to:
 *   - recording.transcript_completed
 *   - recording.completed
 *   - meeting.summary_completed
 *   - meeting.aic_transcript_completed
 *
 * On receipt: verify signature → download transcript → return a RemoteMeeting
 * ready for ingestRemoteMeetings("zoom", [meeting], "oauth").
 *
 * Signature verification follows Zoom's CRC + x-zm-signature scheme.
 * https://developers.zoom.us/docs/api/webhooks/
 */
import type { RemoteMeeting } from "./types.ts";

export type ZoomWebhookEvent =
  | "recording.transcript_completed"
  | "recording.completed"
  | "meeting.summary_completed"
  | "meeting.aic_transcript_completed"
  | "endpoint.url_validation"
  | string;

export type ZoomWebhookPayload = {
  event: ZoomWebhookEvent;
  event_ts?: number;
  payload?: {
    account_id?: string;
    object?: Record<string, unknown>;
    plainToken?: string;
  };
};

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/** Zoom endpoint URL validation (CRC) challenge response. */
export function zoomCrcResponse(
  plainToken: string,
  secretToken: string,
): { plainToken: string; encryptedToken: string } {
  // Node/Web Crypto — sha256 HMAC of plainToken with secretToken
  // Callers in non-Node environments should implement the same HMAC.
  // We export the shape; actual crypto is done by the route handler.
  return { plainToken, encryptedToken: "" }; // placeholder — see hashZoomCrc below
}

/**
 * Compute Zoom CRC encryptedToken = HMAC-SHA256(plainToken, secretToken) as hex.
 * Works in Node (crypto) and browsers (SubtleCrypto async variant available separately).
 */
export async function hashZoomCrc(plainToken: string, secretToken: string): Promise<string> {
  if (typeof globalThis.crypto?.subtle !== "undefined") {
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      enc.encode(secretToken),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sig = await crypto.subtle.sign("HMAC", key, enc.encode(plainToken));
    return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  // Fallback for environments without SubtleCrypto
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const nodeCrypto = await import("node:crypto");
    return nodeCrypto.createHmac("sha256", secretToken).update(plainToken).digest("hex");
  } catch {
    throw new Error("No crypto available for Zoom CRC");
  }
}

/**
 * Verify x-zm-signature header.
 * message = `v0:{timestamp}:{rawBody}`
 * expected = `v0=` + HMAC-SHA256(message, secretToken)
 */
export async function verifyZoomSignature(
  rawBody: string,
  timestamp: string,
  signatureHeader: string,
  secretToken: string,
): Promise<boolean> {
  const message = `v0:${timestamp}:${rawBody}`;
  const expected = `v0=${await hashZoomCrc(message, secretToken)}`;
  // timing-safe-ish compare
  if (expected.length !== signatureHeader.length) return false;
  let ok = 0;
  for (let i = 0; i < expected.length; i++) {
    ok |= expected.charCodeAt(i) ^ signatureHeader.charCodeAt(i);
  }
  return ok === 0;
}

/**
 * Extract a RemoteMeeting from a Zoom recording/transcript webhook payload.
 * The caller must still download the transcript file using a user OAuth token
 * (webhook payloads include download_url but require auth to fetch).
 */
export function parseZoomRecordingWebhook(
  body: ZoomWebhookPayload,
): {
  meetingId: string;
  topic: string;
  startTime: string;
  transcriptDownloadUrl: string | null;
  hostId: string;
} | null {
  const obj = asRecord(body.payload?.object);
  if (!obj) return null;

  const meetingId = str(obj.uuid) || str(obj.id) || str(obj.meeting_id);
  if (!meetingId) return null;

  let transcriptDownloadUrl: string | null = null;
  const files = asArray(obj.recording_files);
  for (const raw of files) {
    const f = asRecord(raw);
    if (!f) continue;
    const ft = str(f.file_type).toUpperCase();
    const ext = str(f.file_extension).toLowerCase();
    if (ft === "TRANSCRIPT" || ft === "CC" || ext === "vtt" || ext === "txt") {
      transcriptDownloadUrl = str(f.download_url) || null;
      if (transcriptDownloadUrl) break;
    }
  }
  // Some events put download_url at the top level of the object
  if (!transcriptDownloadUrl) {
    transcriptDownloadUrl = str(obj.download_url) || null;
  }

  return {
    meetingId,
    topic: str(obj.topic) || "Zoom meeting",
    startTime: str(obj.start_time) || new Date().toISOString(),
    transcriptDownloadUrl,
    hostId: str(obj.host_id),
  };
}

/**
 * Build a RemoteMeeting after the transcript text has been downloaded.
 * Pass the result to ingestRemoteMeetings("zoom", [meeting], "oauth").
 */
export function remoteMeetingFromZoomTranscript(opts: {
  meetingId: string;
  topic: string;
  startTime: string;
  transcript: string;
  attendees?: string[];
  summary?: string;
}): RemoteMeeting {
  return {
    title: opts.topic,
    startedAt: opts.startTime,
    attendees: opts.attendees ?? [],
    summary: opts.summary ?? "",
    decisions: [],
    actionItems: [],
    transcript: opts.transcript,
    sourceFile: `zoom-${opts.meetingId.replace(/[^a-zA-Z0-9_-]/g, "_")}.txt`,
  };
}
