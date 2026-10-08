import type {
  ClientCommand,
  GapSample,
  LiveState,
  PlaybackState,
  ServerMessage,
  SessionIndex,
  SessionInsights,
  Snapshot,
  TrackOutline,
} from "@f1/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { connect, type Target, type Transport } from "./transport";

export type { Target };

export interface TrackerState {
  connected: boolean;
  loading: string | null;
  error: string | null;
  snap: Snapshot | null;
  playback: PlaybackState | null;
  live: LiveState | null;
  index: SessionIndex | null;
  insights: SessionInsights | null;
  outline: TrackOutline | null;
  /** cambia cada vez que se modifica `history` */
  histVersion: number;
}

const INITIAL: TrackerState = {
  connected: false,
  loading: "conectando",
  error: null,
  snap: null,
  playback: null,
  live: null,
  index: null,
  insights: null,
  outline: null,
  histVersion: 0,
};

/** Abre la sesión pedida (por WebSocket o en el Worker local) y mantiene el último estado recibido. */
export function useTracker(target: Target) {
  const [state, setState] = useState<TrackerState>(INITIAL);
  const history = useRef<GapSample[]>([]);
  const transport = useRef<Transport | null>(null);
  const lastTime = useRef<number | undefined>(target.mode === "replay" ? target.at : undefined);
  const key = target.mode === "live" ? "live" : target.source;

  useEffect(() => {
    history.current = [];
    setState(INITIAL);
    const onMessage = (m: ServerMessage) => {
      switch (m.type) {
        case "loading":
          return setState((s) => ({ ...s, loading: m.step, error: null }));
        case "error":
          return setState((s) => ({ ...s, loading: null, error: m.message }));
        case "opened":
          history.current = [];
          return setState((s) => ({
            ...s,
            loading: m.mode === "live" ? "esperando datos" : null,
            error: null,
            index: m.mode === "replay" ? m.index : null,
            insights: m.mode === "replay" ? m.insights : null,
            outline: m.mode === "replay" ? m.outline : null,
            histVersion: s.histVersion + 1,
          }));
        case "outline":
          return setState((s) => ({ ...s, outline: m.outline }));
        case "history":
          history.current = m.reset ? m.points : history.current.concat(m.points);
          return setState((s) => ({ ...s, histVersion: s.histVersion + 1 }));
        case "snapshot":
          if (m.playback) lastTime.current = m.playback.time;
          return setState((s) => ({ ...s, loading: null, snap: m.snap, playback: m.playback ?? null, live: m.live ?? null }));
      }
    };
    const t = connect(target, {
      onMessage,
      onConnected: (connected) => setState((s) => ({ ...s, connected })),
      resumeAt: () => lastTime.current,
    });
    transport.current = t;
    return () => t.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const send = useCallback((cmd: ClientCommand) => transport.current?.send(cmd), []);

  return { ...state, history, send };
}
