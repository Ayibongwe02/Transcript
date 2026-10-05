import type { OAuthConnector } from "./types.ts";

export type OAuthProvider = {
  id: OAuthConnector;
  label: string;
  authUrl: string;
  tokenUrl: string;
  scopes: string;
  extraAuthParams?: Record<string, string>;
  usesBasicAuth?: boolean;
};

export const OAUTH_PROVIDERS: Record<OAuthConnector, OAuthProvider> = {
  slack: {
    id: "slack",
    label: "Slack",
    authUrl: "https://slack.com/oauth/v2/authorize",
    tokenUrl: "https://slack.com/api/oauth.v2.access",
    scopes: "channels:history,channels:read,groups:history,search:read",
  },
  zoom: {
    id: "zoom",
    label: "Zoom",
    authUrl: "https://zoom.us/oauth/authorize",
    tokenUrl: "https://zoom.us/oauth/token",
    // meeting list + summary + cloud recordings + transcript download
    scopes:
      "meeting:read:list_meetings meeting:read:meeting meeting:read:list_past_participants " +
      "cloud_recording:read:list_user_recordings cloud_recording:read:recording " +
      "cloud_recording:read:list_recording_files",
    usesBasicAuth: true,
  },
  gmeet: {
    id: "gmeet",
    label: "Google",
    authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    // Calendar + Drive (Meet transcripts / Gemini notes) + Meet spaces
    scopes:
      "https://www.googleapis.com/auth/calendar.readonly " +
      "https://www.googleapis.com/auth/drive.readonly " +
      "https://www.googleapis.com/auth/drive.meet.readonly " +
      "https://www.googleapis.com/auth/meetings.space.readonly",
    extraAuthParams: {
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "true",
    },
  },
  teams: {
    id: "teams",
    label: "Microsoft",
    authUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    // Calendar + online meetings + transcripts
    scopes:
      "offline_access User.Read Calendars.Read " +
      "OnlineMeetings.Read OnlineMeetingTranscript.Read.All " +
      "OnlineMeetingRecording.Read.All Chat.Read",
  },
  git: {
    id: "git",
    label: "GitHub",
    authUrl: "https://github.com/login/oauth/authorize",
    tokenUrl: "https://github.com/login/oauth/access_token",
    scopes: "repo read:user",
  },
};
