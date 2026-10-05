import type { ConnectorKind, OAuthConnector } from "./types.ts";

const KEY = "knowledge-hub.secrets.v2";
const LEGACY_KEY = "knowledge-hub.secrets.v1";

export type OAuthBundle = {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  clientId?: string;
  clientSecret?: string;
  scope?: string;
};

export type StoredSecret = {
  token?: string;
  oauth?: OAuthBundle;
  clientId?: string;
  clientSecret?: string;
};

type SecretMap = Partial<Record<ConnectorKind, StoredSecret>>;

function coerce(value: unknown): StoredSecret | null {
  if (!value) return null;
  if (typeof value === "string") {
    const token = value.trim();
    return token ? { token } : null;
  }
  if (typeof value !== "object") return null;
  const v = value as StoredSecret;
  const out: StoredSecret = {};
  if (typeof v.token === "string" && v.token.trim()) out.token = v.token.trim();
  if (typeof v.clientId === "string" && v.clientId.trim()) out.clientId = v.clientId.trim();
  if (typeof v.clientSecret === "string" && v.clientSecret.trim()) {
    out.clientSecret = v.clientSecret.trim();
  }
  if (v.oauth && typeof v.oauth.accessToken === "string" && v.oauth.accessToken.trim()) {
    out.oauth = {
      accessToken: v.oauth.accessToken.trim(),
      refreshToken: v.oauth.refreshToken,
      expiresAt: v.oauth.expiresAt,
      clientId: v.oauth.clientId,
      clientSecret: v.oauth.clientSecret,
      scope: v.oauth.scope,
    };
  }
  return out.token || out.oauth || out.clientId ? out : null;
}

function read(): SecretMap {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(KEY) ?? localStorage.getItem(LEGACY_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") return {};
    const out: SecretMap = {};
    for (const [k, v] of Object.entries(parsed)) {
      const secret = coerce(v);
      if (secret) out[k as ConnectorKind] = secret;
    }
    return out;
  } catch {
    return {};
  }
}

function write(map: SecretMap) {
  localStorage.setItem(KEY, JSON.stringify(map));
}

export function getSecret(kind: ConnectorKind): StoredSecret | null {
  return read()[kind] ?? null;
}

export function hasSecret(kind: ConnectorKind): boolean {
  const s = read()[kind];
  if (!s) return false;
  return Boolean(s.token || s.oauth?.accessToken);
}

export function hasOAuth(kind: ConnectorKind): boolean {
  return Boolean(read()[kind]?.oauth?.accessToken);
}

export function saveToken(kind: ConnectorKind, token: string) {
  const next = read();
  const cur = next[kind] ?? {};
  const trimmed = token.trim();
  if (trimmed) cur.token = trimmed;
  else delete cur.token;
  next[kind] = cur;
  write(next);
}

export function saveClientApp(
  kind: ConnectorKind,
  clientId: string,
  clientSecret?: string,
) {
  const next = read();
  const cur = next[kind] ?? {};
  cur.clientId = clientId.trim();
  if (clientSecret && clientSecret.trim()) cur.clientSecret = clientSecret.trim();
  next[kind] = cur;
  write(next);
}

export function saveOAuth(kind: OAuthConnector, bundle: OAuthBundle) {
  const next = read();
  const cur = next[kind] ?? {};
  cur.oauth = {
    accessToken: bundle.accessToken,
    refreshToken: bundle.refreshToken,
    expiresAt: bundle.expiresAt,
    clientId: bundle.clientId ?? cur.clientId,
    clientSecret: bundle.clientSecret ?? cur.clientSecret,
    scope: bundle.scope,
  };
  if (bundle.clientId) cur.clientId = bundle.clientId;
  if (bundle.clientSecret) cur.clientSecret = bundle.clientSecret;
  next[kind] = cur;
  write(next);
}

export function saveSecret(kind: ConnectorKind, value: string) {
  saveToken(kind, value);
}

export function clearSecret(kind: ConnectorKind) {
  const next = read();
  delete next[kind];
  write(next);
}

export function accessTokenFor(kind: ConnectorKind): string | null {
  const s = read()[kind];
  if (!s) return null;
  if (s.oauth?.accessToken) return s.oauth.accessToken;
  if (s.token) return s.token;
  return null;
}

export function oauthBundle(kind: ConnectorKind): OAuthBundle | null {
  return read()[kind]?.oauth ?? null;
}

/** Never return the raw token — only a masked hint for the UI. */
export function maskedHint(kind: ConnectorKind): string | null {
  const token = accessTokenFor(kind);
  if (!token) return null;
  if (token.length <= 4) return "••••";
  return `${"•".repeat(Math.min(12, token.length - 4))}${token.slice(-4)}`;
}

export function savedClientId(kind: ConnectorKind): string {
  return read()[kind]?.clientId ?? "";
}
