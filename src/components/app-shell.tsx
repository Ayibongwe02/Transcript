import { type ReactNode, useEffect, useState } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import { BookOpen, FolderSearch, MessageSquareText, Mic, ScrollText } from "lucide-react";
import { Toaster } from "sonner";
import { HubMark } from "@/components/hub-mark";
import { LiveSessionOverlay } from "@/components/live-session-overlay";
import { LoadingScreen } from "@/components/loading-screen";
import { Onboarding } from "@/components/onboarding";
import { Button } from "@/components/ui/button";
import { RedirectToSignIn, SIGN_IN_PATH, UserButton } from "@/lib/auth/gates";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { formatWhen } from "@/lib/hub/format";
import { drainPendingAnalyses } from "@/lib/hub/run-meeting-analysis";
import { useHydrateHub, useHub } from "@/lib/hub/store";
import { useLiveSession } from "@/lib/hub/use-live-session";
import { hasCompletedOnboarding } from "@/lib/onboarding";
import { cn } from "@/lib/utils";

const MIN_BOOT_MS = 650;

const NAV = [
  { to: "/", label: "Listen", icon: Mic },
  { to: "/minutes", label: "Meetings", icon: ScrollText },
  { to: "/ask", label: "Ask", icon: MessageSquareText },
  { to: "/library", label: "Library", icon: BookOpen },
  { to: "/sources", label: "Sources", icon: FolderSearch },
] as const;

export function AppShell({ children }: { children: ReactNode }) {
  useHydrateHub();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const hydrated = useHub((s) => s.hydrated);
  const meetings = useHub((s) => s.meetings);
  const pendingAnalysisIds = useHub((s) => s.pendingAnalysisIds);
  const isOAuthRoute = pathname.startsWith("/oauth/");
  const isLoginRoute = pathname === SIGN_IN_PATH;
  const { user, isPending: authPending } = useCurrentUserState();
  const { live } = useLiveSession();

  const [showBoot, setShowBoot] = useState(!isOAuthRoute);
  const [minTimeElapsed, setMinTimeElapsed] = useState(false);
  const [tourOpen, setTourOpen] = useState(false);

  useEffect(() => {
    if (isOAuthRoute) return;
    const t = setTimeout(() => setMinTimeElapsed(true), MIN_BOOT_MS);
    return () => clearTimeout(t);
  }, [isOAuthRoute]);

  useEffect(() => {
    if (!hydrated || pendingAnalysisIds.length === 0) return;
    let cancelled = false;
    void (async () => {
      await drainPendingAnalyses();
      if (cancelled) return;
    })();
    return () => {
      cancelled = true;
    };
  }, [hydrated, pendingAnalysisIds.join(",")]);

  const bootReady = hydrated && minTimeElapsed && !authPending;

  /** Boot → tour (if needed) → only then does ListenView start the studio demo. */
  function handleBootDismissed() {
    setShowBoot(false);
    if (!hasCompletedOnboarding()) {
      // Small beat so the shell can settle before the tour fades in
      window.setTimeout(() => setTourOpen(true), 220);
    }
  }

  const recent = meetings
    .slice()
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .slice(0, 6);

  if (isOAuthRoute) {
    return (
      <div className="min-h-dvh bg-bg text-fg">
        {children}
        <Toaster theme="dark" position="bottom-center" richColors={false} />
      </div>
    );
  }

  if (isLoginRoute) {
    return (
      <div className="min-h-dvh bg-bg text-fg">
        {showBoot ? (
          <LoadingScreen ready={bootReady} onDismiss={handleBootDismissed} />
        ) : (
          children
        )}
        <Toaster theme="dark" position="bottom-center" richColors={false} />
      </div>
    );
  }

  const needsSignIn = !authPending && !user;
  const onListen = pathname === "/";

  return (
    <div className="flex min-h-dvh bg-bg text-fg">
      {showBoot ? (
        <LoadingScreen ready={bootReady} onDismiss={handleBootDismissed} />
      ) : needsSignIn ? (
        <RedirectToSignIn />
      ) : (
        <>
          <aside className="sticky top-0 hidden h-dvh w-56 shrink-0 flex-col border-r border-border bg-bg md:flex">
            <div className="flex items-center gap-2.5 px-4 pt-5 pb-4">
              <HubMark />
              <div className="min-w-0">
                <p className="truncate text-sm font-medium tracking-tight text-fg">Knowledge Hub</p>
                <p className="text-2xs text-subtle">Listen · store · analyse</p>
              </div>
            </div>

            <div className="px-3">
              <Button asChild className="w-full justify-start rounded-lg" size="sm">
                <Link to="/">
                  <Mic className="size-4" />
                  New listen
                </Link>
              </Button>
            </div>

            <nav className="mt-4 flex flex-col gap-0.5 px-2">
              {NAV.map((item) => {
                const active = pathname === item.to;
                return (
                  <Link
                    key={item.to}
                    to={item.to}
                    className={cn(
                      "flex h-10 items-center gap-2.5 rounded-md px-3 text-sm font-medium transition-colors duration-150",
                      active ? "bg-elevated text-fg" : "text-muted hover:bg-elevated/60 hover:text-fg",
                    )}
                  >
                    <item.icon className="size-4" />
                    {item.label}
                    {item.to === "/" && live ? (
                      <span className="ml-auto size-1.5 rounded-full bg-accent" />
                    ) : null}
                  </Link>
                );
              })}
            </nav>

            <div className="mt-6 min-h-0 flex-1 overflow-y-auto px-2">
              <p className="px-3 text-2xs font-medium tracking-wider text-subtle uppercase">
                Recent meetings
              </p>
              <ul className="mt-1.5 flex flex-col">
                {recent.length === 0 ? (
                  <li className="px-3 py-2 text-xs text-subtle">None yet</li>
                ) : (
                  recent.map((m) => (
                    <li key={m.id}>
                      <Link
                        to="/minutes"
                        onClick={() => {
                          try {
                            sessionStorage.setItem("knowledge-hub.minutes.openId", m.id);
                          } catch {
                            /* ignore */
                          }
                        }}
                        className="block rounded-md px-3 py-2 hover:bg-elevated/60"
                      >
                        <p className="truncate text-xs text-fg">{m.title}</p>
                        <p className="mt-0.5 font-mono text-2xs tabular-nums text-subtle">
                          {formatWhen(m.startedAt)}
                        </p>
                      </Link>
                    </li>
                  ))
                )}
              </ul>
            </div>

            <div className="mt-auto flex items-center justify-between gap-2 border-t border-border px-3 py-3">
              <Button
                variant="ghost"
                size="sm"
                className="text-subtle"
                onClick={() => setTourOpen(true)}
              >
                Tour
              </Button>
              <UserButton />
            </div>
          </aside>

          <div className="flex min-w-0 flex-1 flex-col">
            <header className="sticky top-0 z-30 flex h-14 items-center justify-between gap-3 border-b border-border bg-bg/90 px-4 backdrop-blur-sm md:hidden">
              <Link to="/" className="flex items-center gap-2">
                <HubMark className="size-7" />
                <span className="text-sm font-medium text-fg">Knowledge Hub</span>
              </Link>
              <div className="flex items-center gap-1">
                {live ? (
                  <span className="mr-1 inline-flex items-center gap-1.5 rounded-full bg-elevated px-2 py-1 text-2xs text-fg">
                    <span className="size-1.5 rounded-full bg-accent" />
                    Live
                  </span>
                ) : null}
                <UserButton />
              </div>
            </header>

            <main className="flex-1 px-4 pt-6 pb-28 md:px-8 md:pt-8 md:pb-10">{children}</main>

            <nav className="fixed right-0 bottom-0 left-0 z-30 border-t border-border bg-bg/95 md:hidden">
              <div className="mx-auto grid max-w-3xl grid-cols-5">
                {NAV.map((item) => {
                  const active = pathname === item.to;
                  return (
                    <Link
                      key={item.to}
                      to={item.to}
                      className={cn(
                        "flex min-h-14 flex-col items-center justify-center gap-1 text-2xs font-medium",
                        active ? "text-fg" : "text-muted",
                      )}
                    >
                      <item.icon className="size-5" />
                      {item.label}
                    </Link>
                  );
                })}
              </div>
            </nav>
          </div>

          {live && !onListen ? <LiveSessionOverlay open onClose={() => undefined} /> : null}
          <Toaster theme="dark" position="bottom-center" richColors={false} />
          <Onboarding open={tourOpen} onOpenChange={setTourOpen} />
        </>
      )}
    </div>
  );
}
