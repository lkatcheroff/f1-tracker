// biome-ignore-all lint/a11y/useSemanticElements: los tramos son elementos de un <svg> y un <button> no existe ahí; llevan role, tabIndex, etiqueta y teclado
import {
  bestLap,
  completedLaps,
  type DominanceSegment,
  dominance,
  indexOutline,
  PARAMS,
  type SessionInsights,
  type TelemetryLap,
  type TrackOutline,
} from "@f1/core";
import { useMemo, useState } from "react";
import type { CircuitInfo } from "./circuit";
import { store } from "./format";
import { SERIES_COLORS } from "./GapChart";
import { projector } from "./mapGeometry";
import { useTelemetry } from "./useTelemetry";

interface Props {
  source: string;
  now: number;
  outline: TrackOutline | null;
  circuit: CircuitInfo | null;
  insights: SessionInsights | null;
  /** nº de auto → color: los pilotos elegidos en la torre (se usan hasta 4) */
  selected: Record<string, string>;
}

const TIE_COLOR = "#74736c";
/** Segundo canal además del color: el trazo, por si dos pilotos se parecen. */
const DASH: ([number, number] | undefined)[] = [undefined, undefined, [3, 1.4], [0.8, 1.6]];
/** Los trazos van en unidades del circuito (décimas de metro): se escalan con el tamaño del mapa. */
const dash = (slot: number, unit: number) => DASH[slot]?.map((n) => n * unit).join(" ");

const secs = (ms: number) => (ms / 1000).toFixed(3).replace(".", ",");

/** Qué piloto fue más rápido en cada tramo del circuito, con la mejor vuelta de cada uno hasta ahora. */
export function DominancePanel({ source, now, outline, circuit, insights, selected }: Props) {
  const [open, setOpen] = useState(() => store.get("f1t:domOpen", false));
  const state = useTelemetry(open ? source : null);
  const [pick, setPick] = useState<number | null>(null);
  const tla = (n: string) => insights?.drivers[n]?.tla ?? n;
  const ids = Object.keys(selected).slice(0, 4);

  const toggle = () => {
    setOpen(!open);
    store.set("f1t:domOpen", !open);
  };

  const tel = state.status === "ready" ? state.data : null;
  const best = useMemo(() => {
    if (!tel) return {};
    const done = completedLaps(tel, now);
    const out: Record<string, TelemetryLap> = {};
    for (const d of ids) {
      const l = bestLap(done.filter((x) => x.d === d));
      if (l) out[d] = l;
    }
    return out;
    // biome-ignore lint/correctness/useExhaustiveDependencies: `ids` sale de `selected`
  }, [tel, now, selected]);
  const have = Object.keys(best);
  const missing = ids.filter((d) => !best[d]);
  const segments = useMemo<DominanceSegment[]>(
    () => (have.length >= 2 ? dominance(best, PARAMS.DOMINANCE_SEGMENTS, PARAMS.DOMINANCE_TIE_MS) : []),
    // biome-ignore lint/correctness/useExhaustiveDependencies: `have` sale de `best`
    [best],
  );

  const geometry = useMemo(() => {
    if (!outline) return null;
    const ix = indexOutline(outline.points);
    const project = projector(circuit?.rotation ?? 0);
    const pts = outline.points.map(([x, y]) => project(x, y));
    const fr = ix.cum.map((c) => c / ix.total);
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (const [x, y] of pts) {
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
    const unit = Math.hypot(maxX - minX, maxY - minY) / 100;
    const paths = Array.from({ length: PARAMS.DOMINANCE_SEGMENTS }, (_, i) => {
      const a = i / PARAMS.DOMINANCE_SEGMENTS;
      const b = (i + 1) / PARAMS.DOMINANCE_SEGMENTS;
      const idx = fr
        .map((f, k) => [f, k] as const)
        .filter(([f]) => f >= a - 1e-9 && f <= b + 1e-9)
        .map(([, k]) => k);
      // un punto antes y uno después, para que los tramos se toquen sin dejar huecos
      const first = Math.max(0, (idx[0] ?? 0) - 1);
      const last = Math.min(pts.length - 1, (idx[idx.length - 1] ?? pts.length - 1) + (b >= 1 ? 0 : 1));
      const seg = pts.slice(first, last + 1);
      if (b >= 1) seg.push(pts[0]);
      return `M${seg.map(([x, y]) => `${x.toFixed(0)},${y.toFixed(0)}`).join("L")}`;
    });
    return { unit, paths, viewBox: `${minX - unit * 6} ${minY - unit * 6} ${maxX - minX + unit * 12} ${maxY - minY + unit * 12}` };
  }, [outline, circuit]);

  const slotOf = (num: string) => Math.max(0, SERIES_COLORS.indexOf(selected[num]));
  const wins = (d: string) => segments.filter((s) => s.winner === d).length;
  const ties = segments.filter((s) => s.winner === null).length;
  const chosen = pick !== null ? segments[pick] : null;

  return (
    <div className="panel dominance">
      <div className="tel-head">
        <h3>Dominio por tramos</h3>
        <button type="button" className="btn" onClick={toggle} aria-expanded={open}>
          {open ? "Cerrar" : "Abrir"}
        </button>
      </div>
      {!open && (
        <p className="chart-note">
          Pinta el circuito con el color del piloto más rápido en cada tramo, comparando las mejores vueltas de los pilotos que elegiste en
          la torre.
        </p>
      )}
      {open && state.status === "loading" && <p className="empty">Bajando la telemetría…</p>}
      {open && state.status === "missing" && <p className="empty">Esta sesión no tiene telemetría: no se puede comparar por tramos.</p>}
      {open && state.status === "error" && <p className="empty">No se pudo cargar la telemetría: {state.message}</p>}
      {open && tel && (
        <>
          {ids.length < 2 && <p className="empty">Elegí de 2 a 4 pilotos haciendo clic en la torre.</p>}
          {ids.length >= 2 && missing.length > 0 && (
            <p className="chart-note">Todavía no tiene una vuelta lanzada completa: {missing.map(tla).join(", ")}.</p>
          )}
          {segments.length > 0 && geometry && (
            <>
              <svg
                viewBox={geometry.viewBox}
                className="dominance-map"
                role="img"
                aria-label="Circuito pintado por tramos según el piloto más rápido"
              >
                <title>Dominio por tramos</title>
                {geometry.paths.map((d, i) => {
                  const s = segments[i];
                  const color = s.winner ? selected[s.winner] : TIE_COLOR;
                  return (
                    <path
                      // biome-ignore lint/suspicious/noArrayIndexKey: los tramos son posicionales y no cambian
                      key={i}
                      d={d}
                      fill="none"
                      stroke={color}
                      strokeWidth={geometry.unit * (pick === i ? 2.8 : 2)}
                      strokeDasharray={s.winner ? dash(slotOf(s.winner), geometry.unit) : undefined}
                      strokeLinecap="butt"
                      opacity={pick === null || pick === i ? 1 : 0.55}
                      role="button"
                      tabIndex={0}
                      aria-label={
                        s.winner ? `Tramo ${i + 1}: gana ${tla(s.winner)} por ${secs(s.marginMs)} segundos` : `Tramo ${i + 1}: empate`
                      }
                      onPointerEnter={() => setPick(i)}
                      onPointerLeave={() => setPick(null)}
                      onFocus={() => setPick(i)}
                      onBlur={() => setPick(null)}
                      onClick={() => setPick(pick === i ? null : i)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") setPick(pick === i ? null : i);
                      }}
                      style={{ cursor: "pointer" }}
                    >
                      <title>
                        {s.winner ? `${tla(s.winner)} gana el tramo ${i + 1} por ${secs(s.marginMs)} s` : `Tramo ${i + 1}: empate`}
                      </title>
                    </path>
                  );
                })}
              </svg>
              <ul className="dom-legend">
                {have.map((d) => (
                  <li key={d}>
                    <svg viewBox="0 0 24 6" className="dom-key" aria-hidden="true">
                      <path d="M0,3H24" stroke={selected[d]} strokeWidth="4" strokeDasharray={dash(slotOf(d), 3)} />
                    </svg>
                    <strong>{tla(d)}</strong> gana {wins(d)} de {segments.length} tramos
                    <span className="muted"> · mejor vuelta V{best[d].n}</span>
                  </li>
                ))}
                {ties > 0 && (
                  <li>
                    <svg viewBox="0 0 24 6" className="dom-key" aria-hidden="true">
                      <path d="M0,3H24" stroke={TIE_COLOR} strokeWidth="4" />
                    </svg>
                    {ties} {ties === 1 ? "tramo" : "tramos"} en empate (menos de {PARAMS.DOMINANCE_TIE_MS} ms)
                  </li>
                )}
              </ul>
              <p className="dom-detail" aria-live="polite">
                {chosen && pick !== null ? (
                  <>
                    Tramo {pick + 1} de {segments.length}:{" "}
                    {Object.entries(chosen.times)
                      .sort((a, b) => a[1] - b[1])
                      .map(([d, t], k, all) => `${tla(d)} ${secs(t)} s${k ? ` (+${secs(t - all[0][1])})` : ""}`)
                      .join(" · ")}
                  </>
                ) : (
                  <span className="muted">Pasá el mouse o tocá un tramo para ver los tiempos.</span>
                )}
              </p>
              <p className="chart-note">
                La traza de cada vuelta se alinea por posición y se escala al tiempo oficial: la precisión por tramo es aproximada, y las
                diferencias de pocas centésimas son ruido.
              </p>
            </>
          )}
        </>
      )}
    </div>
  );
}
