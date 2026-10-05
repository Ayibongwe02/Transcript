import type { HTMLAttributes } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium tracking-wide uppercase",
  {
    variants: {
      tone: {
        meeting: "bg-meeting/15 text-meeting",
        session: "bg-session/15 text-session",
        slack: "bg-slack/15 text-slack",
        whatsapp: "bg-whatsapp/15 text-whatsapp",
        readai: "bg-readai/15 text-readai",
        zoom: "bg-zoom/15 text-zoom",
        gmeet: "bg-gmeet/15 text-gmeet",
        teams: "bg-teams/15 text-teams",
        git: "bg-git/15 text-git",
        muted: "bg-elevated text-muted",
        accent: "bg-accent/15 text-accent",
      },
    },
    defaultVariants: { tone: "muted" },
  },
);

export function Badge({
  className,
  tone,
  ...props
}: HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}
