import { createFileRoute } from "@tanstack/react-router";
import { AskView } from "@/components/ask-view";

export const Route = createFileRoute("/ask")({ component: AskView });
