import type { EventKind, InsightEvent, NeutralSpan, SessionIndex } from "@f1/core";
import { PARAMS } from "@f1/core";
import { useCallback, useEffect, useMemo, useState } from "react";
import { store } from "./format";

/** Cómo se dibuja cada tipo de evento: forma + color (el color nunca es el único canal) y si está prendido por defecto. */
export const EVENT_STYLE: Record<EventKind, { symbol: string; label: string; color: string; on: boolean }> = {
  start: { symbol: "▶", label: "Largada", color: "var(--green)", on: true },
  overtake: { symbol: "▲", label: "Sobrepasos", color: "var(--blue)", on: true },
  leadChange: { symbol: "◆", label: "Cambios de líder", color: "var(--ink)", on: true },
  pit: { symbol: "■", label: "Paradas", color: "var(--ink-2)", on: true },
  fastestLap: { symbol: "★", label: "Vuelta rápida", color: "var(--t-ob)", on: true },
  retirement: { symbol: "✕", label: "Abandonos", color: "var(--red)", on: true },
  penalty: { symbol: "⚑", label: "Sanciones", color: "var(--yellow)", on: true },
  investigation: { symbol: "?", label: "Incidentes", color: "var(--ink-3)", on: false },
  neutralization: { symbol: "▮", label: "Safety Car y banderas", color: "var(--orange)", on: true },
  battle: { symbol: "⚔", label: "Duelos", color: "var(--orange)", on: false },
  undercut: { symbol: "↗", label: "Undercut", color: "var(--accent)", on: true },
  overcut: { symbol: "↘", label: "Overcut", color: "var(--accent)", on: true },
};

export const EVENT_KINDS = Object.keys(EVENT_STYLE) as EventKind[];

const FILTER_KEY = "f1t:eventKinds";

/** Tipos de evento visibles, recordados entre sesiones. */
export function useEventFilter() {
  const [on, setOn] = useState<EventKind[]>(() => {
    const saved = store.get<EventKind[] | null>(FILTER_KEY, null);
    return saved ? saved.filter((k) => k in EVENT_STYLE) : EVENT_KINDS.filter((k) => EVENT_STYLE[k].on);
  });
  useEffect(() => store.set(FILTER_KEY, on), [on]);
  const toggle = useCallback((k: EventKind) => setOn((cur) => (cur.includes(k) ? cur.filter((x) => x !== k) : [...cur, k])), []);
  return { on, set: useMemo(() => new Set(on), [on]), toggle };
}

/**
 * El punto más lejano de la sesión que el usuario ya vio, por sesión. Con "Sin spoilers", las marcas de la línea de
 * tiempo no pasan de ahí: mostrar marcas más adelante revelaría cuándo pasan cosas.
 */
export function useHighWater(source: string, time: number | null) {
  const key = `f1t:hw:${source}`;
  const [hw, setHw] = useState(() => store.get<number>(key, 0));
  useEffect(() => {
    if (time !== null && time > hw) setHw(time);
  }, [time, hw]);
  useEffect(() => {
    const id = setTimeout(() => store.set(key, hw), 1000);
    return () => clearTimeout(id);
  }, [key, hw]);
  const reset = useCallback(
    (to: number) => {
      setHw(to);
      store.set(key, to);
    },
    [key],
  );
  return { highWater: hw, reset };
}

/** Posición (0 a 1) de un instante en la barra: por tiempo, o por vuelta cuando la barra va por vuelta. */
export function makeXOf(index: SessionIndex, byLap: boolean): (ts: number) => number {
  if (!byLap) return (ts) => Math.max(0, Math.min(1, ts / index.duration));
  const laps = index.laps;
  const total = index.totalLaps ?? laps.length;
  return (ts) => {
    let i = laps.length - 1;
    while (i > 0 && laps[i].ts > ts) i--;
    const cur = laps[i];
    const next = laps[i + 1];
    const frac = next ? Math.max(0, Math.min(1, (ts - cur.ts) / (next.ts - cur.ts))) : 0;
    return total > 1 ? Math.max(0, Math.min(1, (cur.lap - 1 + frac) / (total - 1))) : 0;
  };
}

/** A dónde salta un clic en un evento: unos segundos antes, para ver cómo se arma. */
export const jumpTarget = (e: InsightEvent) => Math.max(0, e.seekTs - PARAMS.SEEK_LEAD_MS);

/** Evento anterior o siguiente al instante `time`, para las teclas J y K. */
export function neighbour(events: InsightEvent[], time: number, dir: "prev" | "next"): InsightEvent | null {
  const targets = events.map((e) => ({ e, t: jumpTarget(e) })).sort((a, b) => a.t - b.t);
  if (dir === "next") return targets.find((x) => x.t > time + 500)?.e ?? null;
  return [...targets].reverse().find((x) => x.t < time - 1500)?.e ?? null;
}

export type { NeutralSpan };
