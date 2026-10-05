import { Badge } from "@/components/ui/badge";
import { SOURCE_LABELS, type SourceType } from "@/lib/hub/types";

const TONE: Record<
  SourceType,
  "meeting" | "session" | "slack" | "whatsapp" | "readai" | "zoom" | "gmeet" | "teams" | "git"
> = {
  meeting: "meeting",
  code_session: "session",
  slack: "slack",
  whatsapp: "whatsapp",
  readai: "readai",
  zoom: "zoom",
  gmeet: "gmeet",
  teams: "teams",
  git: "git",
};

export function SourceBadge({ type }: { type: SourceType }) {
  return <Badge tone={TONE[type]}>{SOURCE_LABELS[type]}</Badge>;
}
