import { PARAMS, type PaceStint, type Params, paceStints, type SessionInsights } from "@f1/core";
import { memo, useEffect, useMemo, useRef } from "react";
import uPlot from "uplot";

const INK_2 = "#a8a79f";
const GRID = "#2c2c29";
const COMPOUND: Record<string, string> = { SOFT: "S", MEDIUM: "M", HARD: "H", INTERMEDIATE: "I", WET: "W" };

interface Props {
  insights: SessionInsights;
  /** instante actual: solo cuentan las vueltas ya cerradas */
  now: number;
  /** nº de auto → color, los pilotos elegidos en la torre */
  selected: Record<string, string>;
}

const fmtSlope = (s: number) => `${s >= 0 ? "+" : "−"}${Math.abs(s).toFixed(3).replace(".", ",")}`;

/** Ritmo por neumático: tiempo de vuelta contra edad del neumático para los pilotos elegidos, solo hasta ahora. */
export const PacePanel = memo(function PacePanel({ insights, now, selected }: Props) {
  // Las vueltas visibles cambian una vez por vuelta, no por cada cuadro: se recalcula solo entonces.
  const closed = useMemo(() => insights.laps.filter((l) => l.endTs <= now).length, [insights.laps, now]);
  const stints = useMemo(() => {
    const ids = new Set(Object.keys(selected));
    return insights.stints.filter((s) => ids.has(s.driver)).map((s) => ({ ...s, rows: s.rows.filter((r) => r.endTs <= now) }));
  }, [insights.stints, closed, selected]);
  const pace = useMemo(() => paceStints(stints, { ...PARAMS } as Params), [stints]);

  const host = useRef<HTMLDivElement>(null);
  const plot = useRef<uPlot | null>(null);

  const { data, series } = useMemo(() => {
    const maxAge = Math.max(2, ...pace.flatMap((p) => p.points.map((x) => x.age)));
    const x = Array.from({ length: maxAge }, (_, i) => i + 1);
    return {
      series: pace,
      data: [x, ...pace.map((p) => x.map((age) => p.points.find((q) => q.age === age)?.rel ?? null))] as uPlot.AlignedData,
    };
  }, [pace]);
  const label = (p: PaceStint) => `${p.driver}:${p.stint}`;
  const key = series.map((p) => `${label(p)}:${selected[p.driver]}`).join("|");

  useEffect(() => {
    const el = host.current;
    if (!el || !series.length) return;
    const u = new uPlot(
      {
        width: el.clientWidth,
        height: 200,
        padding: [10, 12, 0, 0],
        legend: { show: false },
        cursor: { y: false, points: { size: 7 } },
        scales: { x: { time: false }, y: { range: (_u, min, max) => [Math.min(min ?? 0, -0.3) - 0.2, Math.max(max ?? 1, 0.5) + 0.2] } },
        axes: [
          {
            stroke: INK_2,
            grid: { stroke: GRID, width: 1 },
            ticks: { stroke: GRID, width: 1 },
            incrs: [1, 2, 5, 10],
            values: (_u, v) => v.map((t) => (Number.isInteger(t) ? String(t) : "")),
            label: "vueltas con este juego de neumáticos",
            labelSize: 14,
            labelFont: "11px system-ui",
            size: 44,
          },
          {
            stroke: INK_2,
            size: 50,
            grid: { stroke: GRID, width: 1 },
            ticks: { stroke: GRID, width: 1 },
            values: (_u, v) => v.map((t) => `${t > 0 ? "+" : ""}${t.toFixed(1)} s`),
          },
        ],
        series: [
          {},
          ...series.map(
            (p): uPlot.Series => ({
              stroke: selected[p.driver],
              width: 2,
              dash: p.stint % 2 ? [6, 4] : undefined,
              spanGaps: true, // las vueltas sucias se descartan: la línea sigue por arriba del hueco
              points: { show: true, size: 5, fill: selected[p.driver] },
            }),
          ),
        ],
      },
      data,
      el,
    );
    plot.current = u;
    const ro = new ResizeObserver(() => u.setSize({ width: el.clientWidth, height: 200 }));
    ro.observe(el);
    return () => {
      ro.disconnect();
      u.destroy();
      plot.current = null;
    };
  }, [key]);

  useEffect(() => {
    plot.current?.setData(data);
  }, [data]);

  const names = insights.drivers;
  return (
    <div className="panel pace">
      <h3>Ritmo por neumático</h3>
      <p className="chart-note">
        Tendencia de ritmo (incluye el efecto de la carga de combustible, que no se corrige). Cada línea es un stint de un piloto elegido en
        la torre; solo vueltas limpias, hasta ahora.
      </p>
      {!Object.keys(selected).length && <p className="empty">Elegí pilotos haciendo clic en la torre.</p>}
      {Object.keys(selected).length > 0 && !series.length && (
        <p className="empty">
          Todavía no hay suficientes vueltas limpias en un mismo juego de neumáticos (hacen falta {PARAMS.MIN_STINT_LAPS}).
        </p>
      )}
      <div ref={host} className={series.length ? "" : "chart-hidden"} />
      {series.length > 0 && (
        <table className="tel-table">
          <thead>
            <tr>
              <th>Piloto</th>
              <th>Neum.</th>
              <th className="num">Vueltas</th>
              <th className="num">Tendencia</th>
              <th className="num">R²</th>
            </tr>
          </thead>
          <tbody>
            {series.map((p) => (
              <tr key={label(p)}>
                <td>
                  <span className="swatch" style={{ background: selected[p.driver] }} /> {names[p.driver]?.tla ?? p.driver}
                  {p.stint ? <span className="muted"> · stint {p.stint + 1}</span> : null}
                </td>
                <td>{COMPOUND[p.compound] ?? p.compound.slice(0, 1)}</td>
                <td className="num">{p.n}</td>
                <td className="num">{fmtSlope(p.slope)} s/v</td>
                <td className="num">{p.r2.toFixed(2).replace(".", ",")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
});
