import type { EventKind, InsightEvent, SessionInsights } from "@f1/core";
import { describe } from "@f1/core";
import { useState } from "react";
import { EVENT_KINDS, EVENT_STYLE } from "./events";
import { fmtDuration, store } from "./format";

interface Props {
  insights: SessionInsights;
  /** eventos ya resueltos en este momento (la compuerta de spoilers la aplica quien llama) */
  events: InsightEvent[];
  filter: { on: EventKind[]; toggle: (k: EventKind) => void };
  startTs: number | null;
  spoilerFree: boolean;
  onJump: (e: InsightEvent) => void;
  onResetHighWater: () => void;
}

/** Línea de tiempo en texto: lo último arriba. Con iconos o como crónica. */
export function EventPanel({ insights, events, filter, startTs, spoilerFree, onJump, onResetHighWater }: Props) {
  const [view, setView] = useState<"icons" | "story">(() => store.get("f1t:eventView", "story"));
  const [copied, setCopied] = useState(false);
  const set = new Set(filter.on);
  const shown = events.filter((e) => set.has(e.kind));
  const present = EVENT_KINDS.filter((k) => events.some((e) => e.kind === k) || insights.events.some((e) => e.kind === k));
  const ctx = { drivers: insights.drivers };
  const mark = (e: InsightEvent) => (e.confidence === "approx" ? "≈ " : "");

  const changeView = (v: "icons" | "story") => {
    setView(v);
    store.set("f1t:eventView", v);
  };
  const copy = async () => {
    const text = [...shown].map((e) => `${mark(e)}${describe(e, ctx)}`).join("\n");
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // sin permiso para el portapapeles: no pasa nada
    }
  };
  const when = (e: InsightEvent) =>
    startTs === null ? fmtDuration(e.ts) : `${e.ts >= startTs ? "" : "−"}${fmtDuration(Math.abs(e.ts - startTs))}`;

  return (
    <div className="panel events">
      <div className="events-head">
        <h3>Eventos</h3>
        <fieldset className="btn-group bare" aria-label="Vista">
          <button type="button" className={`btn btn-small ${view === "story" ? "btn-on" : ""}`} onClick={() => changeView("story")}>
            Crónica
          </button>
          <button type="button" className={`btn btn-small ${view === "icons" ? "btn-on" : ""}`} onClick={() => changeView("icons")}>
            Iconos
          </button>
        </fieldset>
        <button type="button" className="btn btn-small" onClick={copy} disabled={!shown.length} title="Copia la crónica hasta este momento">
          {copied ? "Copiado" : "Copiar"}
        </button>
      </div>

      <fieldset className="chips bare" aria-label="Tipos de evento">
        {present.map((k) => (
          <button
            type="button"
            key={k}
            className={`chip-filter ${set.has(k) ? "on" : ""}`}
            aria-pressed={set.has(k)}
            onClick={() => filter.toggle(k)}
          >
            <span style={{ color: EVENT_STYLE[k].color }} aria-hidden="true">
              {EVENT_STYLE[k].symbol}
            </span>{" "}
            {EVENT_STYLE[k].label}
          </button>
        ))}
      </fieldset>

      {spoilerFree && (
        <p className="chart-note">
          Con “Sin spoilers”, las marcas de la barra llegan hasta donde ya viste.{" "}
          <button type="button" className="linklike" onClick={onResetHighWater}>
            Reiniciar avance
          </button>
        </p>
      )}

      {shown.length ? (
        <ol className="event-list">
          {[...shown].reverse().map((e) => (
            <li key={e.id}>
              <button type="button" className="event-row" onClick={() => onJump(e)}>
                <span className="event-sym" style={{ color: EVENT_STYLE[e.kind].color }} aria-hidden="true">
                  {EVENT_STYLE[e.kind].symbol}
                </span>
                <span className="event-text">
                  {mark(e)}
                  {view === "story"
                    ? describe(e, ctx)
                    : `${EVENT_STYLE[e.kind].label.replace(/s$/, "")} · ${e.drivers.map((n) => insights.drivers[n]?.tla ?? n).join(" · ")}${e.lap ? ` · V${e.lap}` : ""}`}
                </span>
                <span className="event-when">{when(e)}</span>
              </button>
            </li>
          ))}
        </ol>
      ) : (
        <p className="empty">Todavía no pasó nada de lo que seguís. Los eventos aparecen a medida que avanza la sesión.</p>
      )}
    </div>
  );
}
