import type { SessionInsights } from "./types";

/**
 * La compuerta de spoilers: la única función que decide qué se puede mostrar en el instante `now`.
 * Todo lo derivado de la sesión (eventos, crónica, stints, proyecciones, vuelta ideal) pasa por acá con el `ts`
 * en que el dato quedó RESUELTO (`ts`/`endTs`), nunca con el instante al que salta un clic (`seekTs`).
 */
export function visible<T>(items: T[], now: number, ts: (item: T) => number = (item) => (item as { ts: number }).ts): T[] {
  return items.filter((item) => ts(item) <= now);
}

/** El análisis tal como se conoce en `now`: nada posterior. */
export function insightsAt(insights: SessionInsights, now: number): SessionInsights {
  const laps = visible(insights.laps, now, (l) => l.endTs);
  const stints = insights.stints
    .map((s) => ({ ...s, rows: visible(s.rows, now, (r) => r.endTs) }))
    .filter((s) => s.rows.length)
    .map((s) => ({ ...s, lapEnd: s.rows[s.rows.length - 1].lap }));
  const over = insights.endTs !== null && insights.endTs <= now;
  return {
    ...insights,
    endTs: over ? insights.endTs : null,
    // el orden final solo se conoce cuando termina; antes, la última posición conocida es la de la vuelta en curso
    final: over ? insights.final : {},
    laps,
    stints,
    events: visible(insights.events, now),
    changes: visible(insights.changes, now),
  };
}
