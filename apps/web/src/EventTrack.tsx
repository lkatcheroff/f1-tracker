import type { InsightEvent, NeutralSpan } from "@f1/core";
import { describe } from "@f1/core";
import { EVENT_STYLE } from "./events";

interface Props {
  events: InsightEvent[];
  neutral: NeutralSpan[];
  xOf: (ts: number) => number;
  /** hasta dónde se dibujan las franjas abiertas */
  limitTs: number;
  drivers: Parameters<typeof describe>[1]["drivers"];
  onJump: (e: InsightEvent) => void;
}

/** Las marcas de eventos bajo la barra de avance: cada una un botón que lleva a ese momento. */
export function EventTrack({ events, neutral, xOf, limitTs, drivers, onJump }: Props) {
  return (
    <div className="event-track">
      {neutral.map((s) => {
        const from = xOf(s.from);
        const to = xOf(s.to ?? limitTs);
        return (
          <span
            key={`${s.kind}:${s.from}`}
            className={`band band-${s.kind.toLowerCase()}`}
            style={{ left: `${from * 100}%`, width: `${Math.max(0.4, (to - from) * 100)}%` }}
            aria-hidden="true"
          />
        );
      })}
      {events
        .filter((e) => e.kind !== "neutralization")
        .map((e) => {
          const st = EVENT_STYLE[e.kind];
          return (
            <button
              type="button"
              key={e.id}
              className="mark"
              style={{ left: `${xOf(e.seekTs) * 100}%`, color: st.color }}
              onClick={() => onJump(e)}
              title={`${e.confidence === "approx" ? "≈ " : ""}${describe(e, { drivers })}`}
              aria-label={describe(e, { drivers })}
            >
              <span aria-hidden="true">{st.symbol}</span>
            </button>
          );
        })}
    </div>
  );
}
