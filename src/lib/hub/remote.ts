import { createServerFn } from "@tanstack/react-start";
import { classifyCallToolError } from "@/lib/app-data/errors";
import { isLoginRequired } from "@/lib/app-data/login";
import {
  ConnectorType,
  GoogleCalendarTools,
  type CallToolResult,
} from "@/lib/app-data/types";
import { OAUTH_PROVIDERS, type OAuthProvider } from "./oauth-providers.ts";
import type { ActionItem, OAuthConnector, RemoteMeeting } from "./types.ts";

export type TokenBundle = {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  scope?: string;
};

export type SyncOk = {
  ok: true;
  meetings: RemoteMeeting[];
  note?: string;
};

export type SyncErr = {
  ok: false;
  error: string;
  loginRequired?: boolean;
  loginUrl?: string;
  pending?: boolean;
  notConnected?: boolean;
};

function formBody(params: Record<string, string>): string {
  return new URLSearchParams(params).toString();
}

function expiry(seconds: unknown): number | undefined {
  const n = typeof seconds === "number" ? seconds : Number(seconds);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Date.now() + n * 1000;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { raw: text };
  }
}

export const exchangeOAuthCode = createServerFn({ method: "POST" })
  .validator((input: {
    kind: OAuthConnector;
    code: string;
    verifier: string;
    clientId: string;
    clientSecret?: string;
    redirectUri: string;
  }) => input)
  .handler(async ({ data }): Promise<{ ok: true; tokens: TokenBundle } | SyncErr> => {
    const provider: OAuthProvider | undefined = OAUTH_PROVIDERS[data.kind];
    if (!provider) return { ok: false, error: "Unknown provider" };

    const params: Record<string, string> = {
      grant_type: "authorization_code",
      code: data.code,
      redirect_uri: data.redirectUri,
      client_id: data.clientId,
      code_verifier: data.verifier,
    };
    if (data.clientSecret) params.client_secret = data.clientSecret;

    const headers: Record<string, string> = {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    };
    if (provider.usesBasicAuth && data.clientSecret) {
      headers.Authorization = `Basic ${Buffer.from(`${data.clientId}:${data.clientSecret}`).toString("base64")}`;
    }

    try {
      const res = await fetch(provider.tokenUrl, {
        method: "POST",
        headers,
        body: formBody(params),
        signal: AbortSignal.timeout(20000),
      });
      const body = asRecord(await readJson(res));
      if (!res.ok || !body) {
        return {
          ok: false,
          error:
            str(body?.error_description) ||
            str(body?.error) ||
            `Token exchange failed (${res.status}). Check the client ID and redirect URI.`,
        };
      }
      const slackToken = str(body.access_token) || str(asRecord(body.authed_user)?.access_token);
      const access = slackToken;
      if (!access) {
        return { ok: false, error: str(body.error) || "Provider did not return an access token." };
      }
      return {
        ok: true,
        tokens: {
          accessToken: access,
          refreshToken: str(body.refresh_token) || undefined,
          expiresAt: expiry(body.expires_in),
          scope: str(body.scope) || undefined,
        },
      };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : "Token exchange failed" };
    }
  });

export const refreshOAuthToken = createServerFn({ method: "POST" })
  .validator((input: {
    kind: OAuthConnector;
    refreshToken: string;
    clientId: string;
    clientSecret?: string;
  }) => input)
  .handler(async ({ data }): Promise<{ ok: true; tokens: TokenBundle } | SyncErr> => {
    const provider = OAUTH_PROVIDERS[data.kind];
    const params: Record<string, string> = {
      grant_type: "refresh_token",
      refresh_token: data.refreshToken,
      client_id: data.clientId,
    };
    if (data.clientSecret) params.client_secret = data.clientSecret;
    try {
      const res = await fetch(provider.tokenUrl, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
        body: formBody(params),
        signal: AbortSignal.timeout(15000),
      });
      const body = asRecord(await readJson(res));
      const access = str(body?.access_token);
      if (!res.ok || !access) {
        return { ok: false, error: str(body?.error_description) || "Refresh failed. Sign in again." };
      }
      return {
        ok: true,
        tokens: {
          accessToken: access,
          refreshToken: str(body?.refresh_token) || data.refreshToken,
          expiresAt: expiry(body?.expires_in),
        },
      };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : "Refresh failed" };
    }
  });

function authHeader(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, Accept: "application/json" };
}

function flattenText(value: unknown, depth = 0): string {
  if (depth > 4 || value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map((v) => flattenText(v, depth + 1)).filter(Boolean).join("\n");
  const rec = asRecord(value);
  if (!rec) return "";
  const preferred = ["summary", "description", "notes", "content", "text", "body", "recap", "minutes"];
  const bits: string[] = [];
  for (const key of preferred) {
    if (rec[key]) bits.push(flattenText(rec[key], depth + 1));
  }
  return bits.filter(Boolean).join("\n");
}

function attendeesOf(value: unknown): string[] {
  const rec = asRecord(value);
  const list = asArray(rec?.attendees ?? rec?.participants ?? rec?.people);
  const names = list
    .map((item) => {
      if (typeof item === "string") return item;
      const r = asRecord(item);
      return str(r?.displayName) || str(r?.name) || str(r?.email) || str(r?.username);
    })
    .filter(Boolean);
  return [...new Set(names)].slice(0, 16);
}

/**
 * Download a Zoom cloud-recording transcript (VTT/TXT) using the user's OAuth token.
 * Zoom requires the Bearer token on the download_url itself.
 */
async function downloadZoomTranscript(
  token: string,
  downloadUrl: string,
): Promise<string> {
  if (!downloadUrl) return "";
  try {
    const res = await fetch(downloadUrl, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(25000),
    });
    if (!res.ok) return "";
    const text = await res.text();
    return text.trim().slice(0, 200_000);
  } catch {
    return "";
  }
}

/**
 * Resolve transcript text for a past Zoom meeting:
 * 1. List cloud recordings for the meeting UUID/ID
 * 2. Prefer file_type TRANSCRIPT / VTT, fall back to TIMELINE
 * 3. Also try GET /meetings/{id}/transcript when available
 */
async function fetchZoomTranscriptForMeeting(
  token: string,
  meetingId: string | number,
): Promise<{ transcript: string; attendees: string[] }> {
  let transcript = "";
  const attendees: string[] = [];

  // Past participants (best-effort)
  try {
    const pRes = await fetch(
      `https://api.zoom.us/v2/past_meetings/${encodeURIComponent(String(meetingId))}/participants?page_size=30`,
      { headers: authHeader(token), signal: AbortSignal.timeout(12000) },
    );
    if (pRes.ok) {
      const pBody = asRecord(await readJson(pRes));
      for (const raw of asArray(pBody?.participants)) {
        const p = asRecord(raw);
        const name = str(p?.name) || str(p?.user_name);
        if (name) attendees.push(name);
      }
    }
  } catch {
    /* optional */
  }

  // Cloud recordings → transcript file
  try {
    const recRes = await fetch(
      `https://api.zoom.us/v2/meetings/${encodeURIComponent(String(meetingId))}/recordings`,
      { headers: authHeader(token), signal: AbortSignal.timeout(15000) },
    );
    if (recRes.ok) {
      const recBody = asRecord(await readJson(recRes));
      const files = asArray(recBody?.recording_files);
      // Prefer TRANSCRIPT / VTT
      const ranked = [...files].sort((a, b) => {
        const ta = str(asRecord(a)?.file_type).toUpperCase();
        const tb = str(asRecord(b)?.file_type).toUpperCase();
        const score = (t: string) =>
          t === "TRANSCRIPT" ? 0 : t === "CC" || t.includes("VTT") ? 1 : t === "TIMELINE" ? 2 : 9;
        return score(ta) - score(tb);
      });
      for (const raw of ranked) {
        const f = asRecord(raw);
        if (!f) continue;
        const fileType = str(f.file_type).toUpperCase();
        const ext = str(f.file_extension).toLowerCase();
        if (
          fileType === "TRANSCRIPT" ||
          fileType === "CC" ||
          ext === "vtt" ||
          ext === "txt" ||
          fileType === "TIMELINE"
        ) {
          const url = str(f.download_url);
          if (url) {
            transcript = await downloadZoomTranscript(token, url);
            if (transcript) break;
          }
        }
      }
    }
  } catch {
    /* optional */
  }

  // Dedicated transcript endpoint (past instance UUID preferred)
  if (!transcript) {
    try {
      const tRes = await fetch(
        `https://api.zoom.us/v2/meetings/${encodeURIComponent(String(meetingId))}/transcript`,
        { headers: authHeader(token), signal: AbortSignal.timeout(12000) },
      );
      if (tRes.ok) {
        const tBody = asRecord(await readJson(tRes));
        if (tBody?.can_download === true && str(tBody.download_url)) {
          transcript = await downloadZoomTranscript(token, str(tBody.download_url));
        }
      }
    } catch {
      /* optional */
    }
  }

  return { transcript, attendees: [...new Set(attendees)].slice(0, 16) };
}

async function fetchZoom(token: string): Promise<RemoteMeeting[]> {
  // Prefer past meetings with recordings over scheduled list
  let meetings: unknown[] = [];
  try {
    const recList = await fetch(
      "https://api.zoom.us/v2/users/me/recordings?page_size=20",
      { headers: authHeader(token), signal: AbortSignal.timeout(20000) },
    );
    if (recList.ok) {
      const body = asRecord(await readJson(recList));
      meetings = asArray(body?.meetings);
    }
  } catch {
    /* fall through */
  }

  if (meetings.length === 0) {
    const res = await fetch("https://api.zoom.us/v2/users/me/meetings?type=previous&page_size=20", {
      headers: authHeader(token),
      signal: AbortSignal.timeout(20000),
    });
    const body = asRecord(await readJson(res));
    if (!res.ok) throw new Error(str(body?.message) || `Zoom API ${res.status}`);
    meetings = asArray(body?.meetings);
  }

  const out: RemoteMeeting[] = [];
  for (const raw of meetings.slice(0, 12)) {
    const m = asRecord(raw);
    if (!m) continue;
    const id = m.uuid ?? m.id;
    const idStr = String(id ?? "");
    let summary = str(m.agenda) || str(m.topic);

    try {
      const sumRes = await fetch(`https://api.zoom.us/v2/meetings/${encodeURIComponent(idStr)}/meeting_summary`, {
        headers: authHeader(token),
        signal: AbortSignal.timeout(12000),
      });
      if (sumRes.ok) {
        const s = asRecord(await readJson(sumRes));
        summary = flattenText(s) || summary;
      }
    } catch {
      /* optional */
    }

    const { transcript, attendees } = await fetchZoomTranscriptForMeeting(token, idStr);

    out.push({
      title: str(m.topic) || "Zoom meeting",
      startedAt: str(m.start_time) || new Date().toISOString(),
      attendees,
      summary,
      decisions: [],
      actionItems: [],
      transcript,
      sourceFile: `zoom-${idStr.replace(/[^a-zA-Z0-9_-]/g, "_")}.txt`,
    });
  }
  return out;
}

/**
 * Google Meet transcripts land in Drive as Docs (often under "Meet Recordings")
 * or via Meet REST conferenceRecords. We:
 * 1. List Calendar Meet events
 * 2. Search Drive for matching transcript / Gemini notes Docs
 * 3. Export plain text when possible
 */
async function fetchDriveTranscriptText(token: string, fileId: string): Promise<string> {
  if (!fileId) return "";
  // Prefer export as text/plain (Google Docs)
  try {
    const exp = await fetch(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/export?mimeType=text/plain`,
      { headers: authHeader(token), signal: AbortSignal.timeout(20000) },
    );
    if (exp.ok) {
      const text = await exp.text();
      if (text.trim()) return text.trim().slice(0, 200_000);
    }
  } catch {
    /* try alt */
  }
  // Binary / non-Docs fallback
  try {
    const res = await fetch(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`,
      { headers: authHeader(token), signal: AbortSignal.timeout(20000) },
    );
    if (res.ok) {
      const text = await res.text();
      return text.trim().slice(0, 200_000);
    }
  } catch {
    /* optional */
  }
  return "";
}

async function searchDriveMeetTranscripts(
  token: string,
  titleHint: string,
  startedAt: string,
): Promise<string> {
  // Build a Drive query for transcript-like Docs near the meeting time
  const day = startedAt.slice(0, 10); // YYYY-MM-DD
  const safeTitle = titleHint.replace(/['\\]/g, " ").slice(0, 60);
  const queries = [
    `name contains 'Transcript' and modifiedTime >= '${day}T00:00:00Z' and trashed = false`,
    safeTitle
      ? `name contains '${safeTitle.slice(0, 30)}' and (name contains 'Transcript' or name contains 'Notes') and trashed = false`
      : "",
    `name contains 'Notes by Gemini' and modifiedTime >= '${day}T00:00:00Z' and trashed = false`,
  ].filter(Boolean);

  for (const q of queries) {
    try {
      const url =
        "https://www.googleapis.com/drive/v3/files" +
        `?pageSize=5&fields=files(id,name,mimeType,modifiedTime)` +
        `&q=${encodeURIComponent(q)}`;
      const res = await fetch(url, {
        headers: authHeader(token),
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) continue;
      const body = asRecord(await readJson(res));
      for (const raw of asArray(body?.files)) {
        const f = asRecord(raw);
        if (!f) continue;
        const text = await fetchDriveTranscriptText(token, str(f.id));
        if (text.length > 40) return text;
      }
    } catch {
      /* try next query */
    }
  }
  return "";
}

async function fetchGoogleMeet(token: string): Promise<RemoteMeeting[]> {
  const timeMin = new Date(Date.now() - 1000 * 60 * 60 * 24 * 45).toISOString();
  const timeMax = new Date(Date.now() + 1000 * 60 * 60 * 24).toISOString();
  const url =
    "https://www.googleapis.com/calendar/v3/calendars/primary/events" +
    `?singleEvents=true&orderBy=startTime&maxResults=40&timeMin=${encodeURIComponent(timeMin)}` +
    `&timeMax=${encodeURIComponent(timeMax)}`;
  const res = await fetch(url, { headers: authHeader(token), signal: AbortSignal.timeout(20000) });
  const body = asRecord(await readJson(res));
  if (!res.ok) throw new Error(str(body?.error && asRecord(body.error)?.message) || `Google Calendar ${res.status}`);
  const events = asArray(body?.items);
  const out: RemoteMeeting[] = [];
  for (const raw of events) {
    const ev = asRecord(raw);
    if (!ev) continue;
    const hangout = str(ev.hangoutLink);
    const conf = asRecord(ev.conferenceData);
    const entry = asArray(conf?.entryPoints);
    const isMeet =
      hangout.includes("meet.google.com") ||
      entry.some((e) => str(asRecord(e)?.uri).includes("meet.google.com")) ||
      str(asRecord(conf?.conferenceSolution)?.name).toLowerCase().includes("meet");
    if (!isMeet && !hangout) continue;
    const start = asRecord(ev.start);
    const startedAt = str(start?.dateTime) || str(start?.date) || new Date().toISOString();
    const title = str(ev.summary) || "Google Meet";
    const attendees = attendeesOf(ev);

    // Attachments on the calendar event (Gemini notes / transcript links)
    let transcript = "";
    for (const attRaw of asArray(ev.attachments)) {
      const att = asRecord(attRaw);
      if (!att) continue;
      const mime = str(att.mimeType);
      const fileId = str(att.fileId);
      const attTitle = str(att.title).toLowerCase();
      if (
        fileId &&
        (mime.includes("document") ||
          attTitle.includes("transcript") ||
          attTitle.includes("notes") ||
          attTitle.includes("gemini"))
      ) {
        transcript = await fetchDriveTranscriptText(token, fileId);
        if (transcript) break;
      }
    }

    // Drive search fallback
    if (!transcript) {
      transcript = await searchDriveMeetTranscripts(token, title, startedAt);
    }

    out.push({
      title,
      startedAt,
      attendees,
      summary: str(ev.description),
      decisions: [],
      actionItems: [],
      transcript,
      sourceFile: `gmeet-${str(ev.id) || "event"}.txt`,
    });
  }
  return out;
}

/**
 * Microsoft Teams: resolve calendar online meetings → Graph onlineMeeting id → transcripts content (VTT).
 */
async function fetchTeamsTranscriptForMeeting(
  token: string,
  onlineMeetingId: string,
): Promise<string> {
  if (!onlineMeetingId) return "";
  try {
    const listRes = await fetch(
      `https://graph.microsoft.com/v1.0/me/onlineMeetings/${encodeURIComponent(onlineMeetingId)}/transcripts`,
      { headers: authHeader(token), signal: AbortSignal.timeout(15000) },
    );
    if (!listRes.ok) return "";
    const listBody = asRecord(await readJson(listRes));
    const transcripts = asArray(listBody?.value);
    for (const raw of transcripts) {
      const t = asRecord(raw);
      if (!t) continue;
      const tid = str(t.id);
      if (!tid) continue;
      const contentRes = await fetch(
        `https://graph.microsoft.com/v1.0/me/onlineMeetings/${encodeURIComponent(onlineMeetingId)}/transcripts/${encodeURIComponent(tid)}/content`,
        {
          headers: {
            ...authHeader(token),
            Accept: "text/vtt",
          },
          signal: AbortSignal.timeout(20000),
        },
      );
      if (contentRes.ok) {
        const text = await contentRes.text();
        if (text.trim()) return text.trim().slice(0, 200_000);
      }
    }
  } catch {
    /* optional */
  }
  return "";
}

async function resolveTeamsOnlineMeetingId(
  token: string,
  joinUrl: string,
): Promise<string> {
  if (!joinUrl) return "";
  try {
    // Filter onlineMeetings by joinWebUrl
    const filter = encodeURIComponent(`JoinWebUrl eq '${joinUrl.replace(/'/g, "''")}'`);
    const res = await fetch(
      `https://graph.microsoft.com/v1.0/me/onlineMeetings?$filter=${filter}`,
      { headers: authHeader(token), signal: AbortSignal.timeout(15000) },
    );
    if (!res.ok) return "";
    const body = asRecord(await readJson(res));
    const first = asRecord(asArray(body?.value)[0]);
    return str(first?.id);
  } catch {
    return "";
  }
}

async function fetchTeams(token: string): Promise<RemoteMeeting[]> {
  const res = await fetch(
    "https://graph.microsoft.com/v1.0/me/events?$top=30&$orderby=start/dateTime desc&$select=subject,start,end,attendees,bodyPreview,isOnlineMeeting,onlineMeeting,onlineMeetingProvider",
    { headers: authHeader(token), signal: AbortSignal.timeout(20000) },
  );
  const body = asRecord(await readJson(res));
  if (!res.ok) throw new Error(str(body?.error && asRecord(body.error)?.message) || `Microsoft Graph ${res.status}`);
  const events = asArray(body?.value);
  const out: RemoteMeeting[] = [];
  for (const raw of events) {
    const ev = asRecord(raw);
    if (!ev) continue;
    const provider = str(ev.onlineMeetingProvider).toLowerCase();
    const online = asRecord(ev.onlineMeeting);
    const joinUrl = str(online?.joinUrl);
    const isTeams =
      ev.isOnlineMeeting === true ||
      provider.includes("teams") ||
      joinUrl.includes("teams");
    if (!isTeams) continue;
    const start = asRecord(ev.start);
    const startedAt = str(start?.dateTime) || new Date().toISOString();
    const title = str(ev.subject) || "Teams meeting";
    const attendees = attendeesOf(ev);

    let transcript = "";
    // Prefer explicit onlineMeeting id if Graph already returned it
    let meetingId = str(online?.id);
    if (!meetingId && joinUrl) {
      meetingId = await resolveTeamsOnlineMeetingId(token, joinUrl);
    }
    if (meetingId) {
      transcript = await fetchTeamsTranscriptForMeeting(token, meetingId);
    }

    out.push({
      title,
      startedAt,
      attendees,
      summary: str(ev.bodyPreview),
      decisions: [],
      actionItems: [],
      transcript,
      sourceFile: `teams-${str(ev.id).slice(0, 18) || "event"}.txt`,
    });
  }
  return out;
}

async function fetchSlack(token: string): Promise<RemoteMeeting[]> {
  const list = await fetch("https://slack.com/api/conversations.list?limit=8&exclude_archived=true", {
    headers: authHeader(token),
    signal: AbortSignal.timeout(15000),
  });
  const listed = asRecord(await readJson(list));
  if (!listed || listed.ok === false) {
    throw new Error(str(listed?.error) || `Slack API ${list.status}`);
  }
  const channels = asArray(listed.channels);
  const messages: string[] = [];
  const attendees = new Set<string>();
  for (const ch of channels.slice(0, 5)) {
    const c = asRecord(ch);
    const id = str(c?.id);
    if (!id) continue;
    const hist = await fetch(`https://slack.com/api/conversations.history?channel=${id}&limit=15`, {
      headers: authHeader(token),
      signal: AbortSignal.timeout(12000),
    });
    const h = asRecord(await readJson(hist));
    for (const raw of asArray(h?.messages)) {
      const m = asRecord(raw);
      const text = str(m?.text);
      if (!text) continue;
      const user = str(m?.user) || "member";
      attendees.add(user);
      messages.push(`${user}: ${text}`);
    }
  }
  if (!messages.length) return [];
  return [
    {
      title: "Slack recent channels",
      startedAt: new Date().toISOString(),
      attendees: [...attendees].slice(0, 12),
      summary: messages.slice(0, 8).join("\n"),
      decisions: [],
      actionItems: [],
      transcript: messages.join("\n"),
      sourceFile: "slack-sync.json.txt",
    },
  ];
}

async function fetchReadAi(token: string): Promise<RemoteMeeting[]> {
  const urls = [
    "https://api.read.ai/v1/meetings",
    "https://api.read.ai/meetings",
  ];
  for (const url of urls) {
    const res = await fetch(url, {
      headers: { ...authHeader(token), "x-api-key": token },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) continue;
    const body = await readJson(res);
    const items = Array.isArray(body) ? body : asArray(asRecord(body)?.meetings ?? asRecord(body)?.data);
    return items.slice(0, 12).map((raw, i) => {
      const m = asRecord(raw) ?? {};
      return {
        title: str(m.title) || str(m.name) || `Read AI meeting ${i + 1}`,
        startedAt: str(m.start_time) || str(m.startedAt) || str(m.date) || new Date().toISOString(),
        attendees: attendeesOf(m),
        summary: flattenText(m.summary) || str(m.summary),
        decisions: asArray(m.decisions).map((d) => (typeof d === "string" ? d : flattenText(d))).filter(Boolean),
        actionItems: asArray(m.action_items ?? m.actionItems).map((a) => {
          const rec = asRecord(a);
          return {
            owner: str(rec?.owner) || str(rec?.assignee) || "unassigned",
            text: str(rec?.text) || str(rec?.title) || flattenText(a),
          };
        }).filter((a) => a.text),
        transcript: flattenText(m.transcript),
        sourceFile: `readai-${str(m.id) || i}.txt`,
      };
    });
  }
  throw new Error("Read AI API did not return meetings. Paste notes or check the key.");
}

export const syncRemoteSource = createServerFn({ method: "POST" })
  .validator((input: { kind: "zoom" | "gmeet" | "teams" | "slack" | "readai"; accessToken: string }) => {
    return { kind: input.kind, accessToken: (input.accessToken ?? "").trim() };
  })
  .handler(async ({ data }): Promise<SyncOk | SyncErr> => {
    if (!data.accessToken) return { ok: false, error: "No access token. Sign in or paste an API token." };
    try {
      let meetings: RemoteMeeting[] = [];
      if (data.kind === "zoom") meetings = await fetchZoom(data.accessToken);
      else if (data.kind === "gmeet") meetings = await fetchGoogleMeet(data.accessToken);
      else if (data.kind === "teams") meetings = await fetchTeams(data.accessToken);
      else if (data.kind === "slack") meetings = await fetchSlack(data.accessToken);
      else meetings = await fetchReadAi(data.accessToken);
      if (meetings.length === 0) {
        return {
          ok: true,
          meetings: [],
          note: "Connected, but no recent meetings came back. Import an export to index minutes.",
        };
      }
      return { ok: true, meetings };
    } catch (e) {
      return {
        ok: false,
        error:
          e instanceof Error
            ? e.message
            : "Sync failed. Sign in again or import an export.",
      };
    }
  });

function grokMeetingsFromTool(result: CallToolResult, platform: "gmeet" | "teams"): RemoteMeeting[] {
  const data = result.data;
  const rec = asRecord(data);
  const items = Array.isArray(data)
    ? data
    : asArray(rec?.events ?? rec?.items ?? rec?.value ?? rec?.messages ?? rec?.results ?? rec?.data);
  const meetings: RemoteMeeting[] = [];
  for (const raw of items.slice(0, 20)) {
    const ev: Record<string, unknown> = asRecord(raw) ?? { text: raw };
    const title = str(ev.summary) || str(ev.subject) || str(ev.title) || str(ev.name) || (platform === "gmeet" ? "Google Meet" : "Teams");
    const start = asRecord(ev.start);
    const startedAt =
      str(start?.dateTime) ||
      str(ev.start_time) ||
      str(ev.timestamp) ||
      str(ev.created) ||
      new Date().toISOString();
    const text = flattenText(ev);
    meetings.push({
      title,
      startedAt,
      attendees: attendeesOf(ev),
      summary: text.slice(0, 1200),
      decisions: [],
      actionItems: [],
      transcript: str(ev.text) || str(ev.body) || "",
      sourceFile: `${platform}-grok-${title.slice(0, 24).replace(/\s+/g, "-")}.txt`,
    });
  }
  return meetings;
}

function grokErr(result: CallToolResult): SyncErr {
  const classified = classifyCallToolError(result);
  return {
    ok: false,
    error: classified?.message || result.errorMessage || "Could not read this connector.",
    loginRequired: isLoginRequired(result) || classified?.kind === "login",
    loginUrl: result.loginUrl,
    pending: result.pending === true || classified?.kind === "pending",
    notConnected: classified?.kind === "not_connected",
  };
}

export const syncGrokGoogleMeet = createServerFn({ method: "POST" }).handler(
  async (): Promise<SyncOk | SyncErr> => {
    const { callTool } = await import("@/lib/app-data/client.server");
    const timeMin = new Date(Date.now() - 1000 * 60 * 60 * 24 * 45).toISOString();
    const result = await callTool(
      GoogleCalendarTools.search,
      {
        query: "meet.google.com OR Google Meet",
        time_min: timeMin,
        timeMin,
        max_results: 25,
        maxResults: 25,
      },
      { connectorType: ConnectorType.GoogleCalendar },
    );
    if (!result.ok) return grokErr(result);
    const meetings = grokMeetingsFromTool(result, "gmeet");
    return {
      ok: true,
      meetings,
      note: meetings.length
        ? undefined
        : "Google Calendar connected, but no Meet events were returned.",
    };
  },
);

export const syncGrokTeams = createServerFn({ method: "POST" }).handler(
  async (): Promise<SyncOk | SyncErr> => {
    const { callTool } = await import("@/lib/app-data/client.server");
    const attempts: { tool: string; type: typeof ConnectorType.MicrosoftTeams | typeof ConnectorType.OutlookCalendar; args: Record<string, unknown> }[] = [
      {
        tool: "microsoft_teams_search",
        type: ConnectorType.MicrosoftTeams,
        args: { query: "meeting OR standup OR recap OR minutes" },
      },
      {
        tool: "outlook_calendar_search",
        type: ConnectorType.OutlookCalendar,
        args: { query: "Teams meeting", time_min: new Date(Date.now() - 1000 * 60 * 60 * 24 * 45).toISOString() },
      },
    ];
    let last: CallToolResult | null = null;
    for (const attempt of attempts) {
      const result = await callTool(attempt.tool, attempt.args, { connectorType: attempt.type });
      last = result;
      if (result.ok) {
        const meetings = grokMeetingsFromTool(result, "teams");
        return {
          ok: true,
          meetings,
          note: meetings.length ? undefined : "Connected, but no Teams meetings came back.",
        };
      }
      if (result.pending || isLoginRequired(result)) return grokErr(result);
    }
    return last ? grokErr(last) : { ok: false, error: "Teams connector is unavailable." };
  },
);
