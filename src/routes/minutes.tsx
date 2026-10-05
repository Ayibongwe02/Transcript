import { createFileRoute } from "@tanstack/react-router";
import { MinutesView } from "@/components/minutes-view";

export const Route = createFileRoute("/minutes")({ component: MinutesView });
