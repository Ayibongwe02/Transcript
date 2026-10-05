import { createFileRoute } from "@tanstack/react-router";
import { ListenView } from "@/components/listen-view";

export const Route = createFileRoute("/")({ component: ListenView });
