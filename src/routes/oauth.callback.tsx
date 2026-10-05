import { useEffect } from "react";
import { createFileRoute } from "@tanstack/react-router";

function OAuthCallback() {
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    const payload = {
      type: "knowledge-hub-oauth",
      code: params.get("code") || hash.get("code"),
      state: params.get("state") || hash.get("state"),
      error: params.get("error") || hash.get("error"),
      errorDescription: params.get("error_description") || hash.get("error_description"),
    };
    if (window.opener && !window.opener.closed) {
      window.opener.postMessage(payload, window.location.origin);
      window.close();
      return;
    }
    try {
      sessionStorage.setItem("knowledge-hub.oauth.result", JSON.stringify(payload));
    } catch {
      /* ignore */
    }
    window.location.replace("/sources");
  }, []);

  return (
    <div className="flex min-h-[50vh] flex-col items-center justify-center gap-2 px-6 text-center">
      <p className="font-display text-2xl text-fg">Finishing sign-in…</p>
      <p className="text-sm text-muted">You can close this window if it does not close itself.</p>
    </div>
  );
}

export const Route = createFileRoute("/oauth/callback")({ component: OAuthCallback });
