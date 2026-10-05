import { useEffect, useState } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Link } from "@tanstack/react-router";
import {
  ArrowLeft,
  ArrowRight,
  GitBranch,
  Mic,
  MessageSquareText,
  ScrollText,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { markOnboardingComplete } from "@/lib/onboarding";
import { cn } from "@/lib/utils";

type Step = {
  kicker: string;
  title: string;
  body: string;
};

const STEPS: Step[] = [
  {
    kicker: "The job",
    title: "Listen to the meeting happening on this computer.",
    body: "Zoom, Teams, Meet — Knowledge Hub overhears from your mic or system audio. No bot to invite. No extra setup in the call.",
  },
  {
    kicker: "Then",
    title: "Store the transcript. Write the brief.",
    body: "When you end the session, the full transcript is saved. Claude or Grok reads it and extracts the objective, the topics, and the solutions people actually proposed.",
  },
  {
    kicker: "The project",
    title: "Tie it back to the repo you were talking about.",
    body: "If the meeting named a project, link that git repo so the brief can suggest patches against real code — review only, never applied automatically.",
  },
  {
    kicker: "Later",
    title: "Ask anything across what you overheard.",
    body: "Questions stay grounded in the minutes and the linked repo, with citations back to the source.",
  },
];

const START_LINKS = [
  { to: "/", label: "Start listening", icon: Mic },
  { to: "/minutes", label: "Open meetings", icon: ScrollText },
  { to: "/ask", label: "Ask a question", icon: MessageSquareText },
] as const;

export function Onboarding({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [step, setStep] = useState(0);
  const last = step === STEPS.length - 1;
  const first = step === 0;

  useEffect(() => {
    if (open) setStep(0);
  }, [open]);

  function finish() {
    markOnboardingComplete();
    onOpenChange(false);
  }

  const current = STEPS[step];

  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) finish();
        else onOpenChange(next);
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-bg/80 backdrop-blur-sm transition-opacity duration-300" />
        <DialogPrimitive.Content
          onOpenAutoFocus={(e) => e.preventDefault()}
          onPointerDownOutside={(e) => e.preventDefault()}
          className={cn(
            "ios-tour-content fixed top-1/2 left-1/2 z-50 w-[min(94vw,520px)] -translate-x-1/2 -translate-y-1/2",
            "overflow-hidden rounded-xl bg-surface shadow-[var(--shadow-border)]",
            "focus:outline-none",
          )}
        >
          <DialogPrimitive.Title className="sr-only">Welcome to Knowledge Hub</DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">
            A short tour of listening, storing, and analysing meetings.
          </DialogPrimitive.Description>

          <div
            className="h-0.5 w-full bg-elevated"
            role="progressbar"
            aria-valuemin={1}
            aria-valuemax={STEPS.length}
            aria-valuenow={step + 1}
          >
            <div
              className="h-full bg-accent transition-[width] duration-500 ease-[var(--ease-out)]"
              style={{ width: `${((step + 1) / STEPS.length) * 100}%` }}
            />
          </div>

          <DialogPrimitive.Close asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Skip tour"
              className="absolute top-4 right-4 text-muted"
            >
              <X />
            </Button>
          </DialogPrimitive.Close>

          <div key={step} className="p-7">
            <p className="text-2xs font-medium tracking-wider text-muted uppercase">
              {current.kicker}
            </p>
            <h2 className="mt-2 font-display text-3xl leading-tight text-fg">{current.title}</h2>
            <p className="mt-3 text-sm leading-relaxed text-muted">{current.body}</p>

            {step === 2 ? (
              <p className="mt-4 inline-flex items-center gap-2 rounded-lg bg-elevated px-3 py-2 text-xs text-muted">
                <GitBranch className="size-3.5" />
                Review with git — never auto-apply
              </p>
            ) : null}

            {last ? (
              <div className="mt-6 flex flex-col gap-2">
                {START_LINKS.map((l) => (
                  <Link
                    key={l.to}
                    to={l.to}
                    onClick={finish}
                    className="flex h-11 items-center gap-3 rounded-lg bg-elevated px-4 text-sm font-medium text-fg hover:bg-elevated/80"
                  >
                    <l.icon className="size-4 text-muted" />
                    {l.label}
                    <ArrowRight className="ml-auto size-4 text-muted" />
                  </Link>
                ))}
              </div>
            ) : null}
          </div>

          <div className="flex items-center justify-between border-t border-border px-7 py-3">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setStep((s) => Math.max(0, s - 1))}
              className={cn(first && "invisible")}
            >
              <ArrowLeft className="size-3.5" />
              Back
            </Button>
            <div className="flex items-center gap-1.5">
              {STEPS.map((s, i) => (
                <span
                  key={s.kicker}
                  className={cn(
                    "h-1.5 rounded-full transition-all duration-300 ease-[var(--ease-out)]",
                    i === step ? "w-5 bg-accent" : "w-1.5 bg-border-strong",
                  )}
                />
              ))}
            </div>
            {last ? (
              <Button size="sm" onClick={finish}>
                Done
              </Button>
            ) : (
              <Button size="sm" onClick={() => setStep((s) => Math.min(STEPS.length - 1, s + 1))}>
                Next
                <ArrowRight className="size-3.5" />
              </Button>
            )}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
