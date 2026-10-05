import { useEffect, useState } from "react";
import {
  getLiveSessionEngine,
  type LiveListenState,
  type LiveSessionSnapshot,
} from "./live-session.ts";

const LIVE_STATES: LiveListenState[] = [
  "requesting",
  "listening",
  "speaking",
  "silent",
  "likely_muted",
  "paused",
];

export function isLiveState(state: LiveListenState): boolean {
  return LIVE_STATES.includes(state);
}

export function useLiveSession() {
  const engine = getLiveSessionEngine();
  const [snap, setSnap] = useState<LiveSessionSnapshot>(() => engine.snapshot());

  useEffect(() => engine.subscribe(setSnap), [engine]);

  return { engine, snap, live: isLiveState(snap.state) };
}
