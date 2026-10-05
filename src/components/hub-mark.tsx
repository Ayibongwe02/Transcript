import { cn } from "@/lib/utils";

export function HubMark({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex size-8 items-end justify-center gap-0.5 rounded-lg bg-elevated px-1.5 py-1.5",
        className,
      )}
      aria-hidden
    >
      <span className="h-2 w-0.5 rounded-full bg-fg/50" />
      <span className="h-3.5 w-0.5 rounded-full bg-fg" />
      <span className="h-2.5 w-0.5 rounded-full bg-fg/70" />
      <span className="h-1.5 w-0.5 rounded-full bg-fg/40" />
    </span>
  );
}
