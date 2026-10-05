import { createFileRoute } from "@tanstack/react-router";
import { SourcesView } from "@/components/sources-view";

export const Route = createFileRoute("/sources")({ component: SourcesView });
