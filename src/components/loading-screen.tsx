import { useEffect, useState } from "react";
import { HubMark } from "@/components/hub-mark";
import { cn } from "@/lib/utils";

const STATUS_MESSAGES = ["Opening the studio", "Warming the index", "Ready to listen"] as const;

export function LoadingScreen({
  ready,
  onDismiss,
}: {
  ready: boolean;
  onDismiss: () => void;
}) {
  const [exiting, setExiting] = useState(false);
  const [statusIndex, setStatusIndex] = useState(0);

  useEffect(() => {
    const id = setInterval(() => {
      setStatusIndex((i) => (i + 1) % STATUS_MESSAGES.length);
    }, 1100);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (!ready || exiting) return;
    setExiting(true);
    const timeout = setTimeout(onDismiss, 480);
    return () => clearTimeout(timeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  return (
    <div
      aria-hidden={exiting}
      className={cn(
        "fixed inset-0 z-[60] flex flex-col items-center justify-center gap-6 bg-bg",
        exiting ? "opacity-0 transition-opacity duration-500 ease-[var(--ease-out)]" : "opacity-100",
      )}
    >
      <HubMark className="size-12 rounded-xl" />
      <div className="flex flex-col items-center gap-2 text-center">
        <p className="font-display text-3xl leading-none text-fg">Knowledge Hub</p>
        <p
          key={statusIndex}
          className="h-4 font-mono text-2xs tracking-wider text-muted uppercase"
        >
          {STATUS_MESSAGES[statusIndex]}
        </p>
      </div>
      <div className="h-px w-36 overflow-hidden rounded-full bg-elevated">
        <div
          className={cn(
            "h-full rounded-full bg-accent",
            exiting
              ? "w-full transition-[width] duration-300 ease-[var(--ease-out)]"
              : "w-1/3 animate-loader-sweep",
          )}
        />
      </div>
    </div>
  );
}
