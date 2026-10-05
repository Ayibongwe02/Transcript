import { useEffect, useState, type FormEvent } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { HubMark } from "@/components/hub-mark";
import { authClient } from "@/lib/auth/client";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

type Mode = "sign_in" | "sign_up";

function LoginPage() {
  const navigate = useNavigate();
  const { user, isPending: sessionPending } = useCurrentUserState();

  const [mode, setMode] = useState<Mode>("sign_in");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!sessionPending && user) {
      void navigate({ to: "/", replace: true });
    }
  }, [sessionPending, user, navigate]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const { error: authError } =
        mode === "sign_in"
          ? await authClient.signIn.email({ email, password })
          : await authClient.signUp.email({ email, password, name: name || email });
      if (authError) {
        setError(authError.message ?? "Something went wrong. Please try again.");
        return;
      }
      // No explicit navigate here: the session store refreshes asynchronously, so
      // navigating immediately lands on "/" while it still reads signed-out and
      // bounces / -> /login -> /. The effect above redirects once the user is set.
    } catch {
      setError("Couldn't reach the server. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  if (sessionPending || user) return null;

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-8 bg-bg px-4 text-fg">
      <div className="flex flex-col items-center gap-3 text-center">
        <HubMark className="size-11 rounded-xl" />
        <p className="font-display text-3xl leading-none text-fg">Knowledge Hub</p>
        <p className="text-sm text-muted">
          {mode === "sign_in" ? "Sign in to your workspace." : "Create an account to get started."}
        </p>
      </div>

      <form
        onSubmit={handleSubmit}
        className="flex w-full max-w-sm flex-col gap-4 rounded-xl bg-surface p-6 shadow-[var(--shadow-border)]"
      >
        {mode === "sign_up" ? (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="name">Name</Label>
            <Input
              id="name"
              autoComplete="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Ada Lovelace"
            />
          </div>
        ) : null}

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="password">Password</Label>
          <Input
            id="password"
            type="password"
            required
            minLength={8}
            autoComplete={mode === "sign_in" ? "current-password" : "new-password"}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
          />
        </div>

        {error ? <p className="text-sm text-danger">{error}</p> : null}

        <Button type="submit" disabled={submitting} className="mt-1">
          {submitting
            ? mode === "sign_in"
              ? "Signing in…"
              : "Creating account…"
            : mode === "sign_in"
              ? "Sign in"
              : "Create account"}
        </Button>

        <button
          type="button"
          onClick={() => {
            setError(null);
            setMode((m) => (m === "sign_in" ? "sign_up" : "sign_in"));
          }}
          className={cn("text-center text-sm text-muted underline-offset-4 hover:text-fg hover:underline")}
        >
          {mode === "sign_in" ? "Need an account? Create one" : "Already have an account? Sign in"}
        </button>
      </form>
    </div>
  );
}

export const Route = createFileRoute("/login")({ component: LoginPage });
