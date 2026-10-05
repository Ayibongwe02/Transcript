import { randomId } from "./ids.ts";
import { OAUTH_PROVIDERS } from "./oauth-providers.ts";
import type { OAuthConnector } from "./types.ts";

export { OAUTH_PROVIDERS } from "./oauth-providers.ts";
export type { OAuthProvider } from "./oauth-providers.ts";

const SESSION_KEY = "knowledge-hub.oauth.pending";

export type PendingOAuth = {
  kind: OAuthConnector;
  verifier: string;
  state: string;
  clientId: string;
  clientSecret?: string;
};

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function generatePKCE(): Promise<{ verifier: string; challenge: string }> {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const verifier = b64url(bytes);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: b64url(new Uint8Array(digest)) };
}

export function redirectUri(): string {
  return `${window.location.origin}/oauth/callback`;
}

export async function beginOAuth(opts: {
  kind: OAuthConnector;
  clientId: string;
  clientSecret?: string;
}): Promise<PendingOAuth> {
  const provider = OAUTH_PROVIDERS[opts.kind];
  const { verifier, challenge } = await generatePKCE();
  const state = randomId("st");
  const pending: PendingOAuth = {
    kind: opts.kind,
    verifier,
    state,
    clientId: opts.clientId.trim(),
    clientSecret: opts.clientSecret?.trim() || undefined,
  };
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(pending));

  const url = new URL(provider.authUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", pending.clientId);
  url.searchParams.set("redirect_uri", redirectUri());
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  if (provider.id === "slack") url.searchParams.set("user_scope", "");
  url.searchParams.set("scope", provider.scopes);
  if (provider.extraAuthParams) {
    for (const [k, v] of Object.entries(provider.extraAuthParams)) url.searchParams.set(k, v);
  }

  const popup = window.open(url.toString(), "kh-oauth", "width=480,height=740,noopener=no");
  if (!popup) {
    window.location.assign(url.toString());
  }
  return pending;
}

export function readPendingOAuth(): PendingOAuth | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as PendingOAuth;
  } catch {
    return null;
  }
}

export function clearPendingOAuth() {
  sessionStorage.removeItem(SESSION_KEY);
}

export function waitForOAuthCode(state: string, timeoutMs = 180000): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      window.removeEventListener("message", onMsg);
      reject(new Error("Sign-in timed out. You can paste an API token instead."));
    }, timeoutMs);

    function onMsg(event: MessageEvent) {
      if (event.origin !== window.location.origin) return;
      const data = event.data as {
        type?: string;
        code?: string | null;
        state?: string | null;
        error?: string | null;
        errorDescription?: string | null;
      };
      if (data?.type !== "knowledge-hub-oauth") return;
      if (data.state && data.state !== state) return;
      window.clearTimeout(timer);
      window.removeEventListener("message", onMsg);
      if (data.error) {
        reject(new Error(data.errorDescription || data.error));
        return;
      }
      if (!data.code) {
        reject(new Error("No authorization code returned."));
        return;
      }
      resolve(data.code);
    }
    window.addEventListener("message", onMsg);
  });
}
