import type { GapSample } from "@f1/core";
import { memo, useEffect, useRef, type RefObject } from "react";
import uPlot from "uplot";
import { fmtDuration } from "./format";

/** Paleta categórica (slots 1 a 4, pasos para fondo oscuro), validada para daltonismo sobre #1a1a19. */
export const SERIES_COLORS = ["#3987e5", "#d95926", "#199e70", "#c98500"];

const INK = "#f4f4f1";
const INK_2 = "#a8a79f";
const GRID = "#2c2c29";

export interface ChartSeries {
  num: string;
  tla: string;
  color: string;
}

interface Props {
  history: RefObject<GapSample[]>;
  version: number;
  series: ChartSeries[];
  /** En carrera es el gap al líder; en práctica y clasificación, la diferencia con el mejor tiempo. */
  race: boolean;
}

function toData(history: GapSample[], series: ChartSeries[]): uPlot.AlignedData {
  const t0 = history[0]?.t ?? 0;
  return [
    history.map((p) => (p.t - t0) / 60_000),
    ...series.map((s) => history.map((p) => p.gaps[s.num] ?? null)),
  ] as uPlot.AlignedData;
}

/** Etiqueta cada línea en su último punto; si dos terminan juntas, las separa en vertical. */
function drawEndLabels(u: uPlot, series: ChartSeries[]): void {
  const px = devicePixelRatio || 1;
  const labels: { tla: string; x: number; y: number }[] = [];
  series.forEach((s, i) => {
    const ys = u.data[i + 1];
    for (let j = ys.length - 1; j >= 0; j--) {
      const v = ys[j];
      if (v == null) continue;
      labels.push({ tla: s.tla, x: u.valToPos(u.data[0][j], "x", true), y: u.valToPos(v, "y", true) });
      break;
    }
  });
  labels.sort((a, b) => a.y - b.y);
  const minGap = 12 * px;
  for (let i = 1; i < labels.length; i++) if (labels[i].y - labels[i - 1].y < minGap) labels[i].y = labels[i - 1].y + minGap;

  const ctx = u.ctx;
  ctx.save();
  ctx.font = `600 ${11 * px}px system-ui, sans-serif`;
  ctx.fillStyle = INK;
  ctx.textBaseline = "middle";
  for (const l of labels) ctx.fillText(l.tla, l.x + 6 * px, l.y);
  ctx.restore();
}

export const GapChart = memo(function GapChart({ history, version, series, race }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const plot = useRef<uPlot | null>(null);
  const seriesKey = series.map((s) => `${s.num}:${s.color}`).join(",");
  const hasData = history.current.length > 1 && series.length > 0;

  useEffect(() => {
    const el = host.current;
    if (!el || !series.length) return;
    const u = new uPlot(
      {
        width: el.clientWidth,
        height: 220,
        padding: [10, 44, 0, 0],
        scales: {
          x: { time: false },
          y: { range: (_u, _min, max) => [0, Math.max(max ?? 0, 2) * 1.08] },
        },
        axes: [
          {
            stroke: INK_2,
            grid: { stroke: GRID, width: 1 },
            ticks: { stroke: GRID, width: 1 },
            values: (_u, vals) => vals.map((v) => `${v}′`),
          },
          {
            stroke: INK_2,
            size: 46,
            grid: { stroke: GRID, width: 1 },
            ticks: { stroke: GRID, width: 1 },
            values: (_u, vals) => vals.map((v) => `${v} s`),
          },
        ],
        series: [
          {
            label: "Momento",
            value: (_u, v, _si, idx) => {
              const p = idx == null ? undefined : history.current[idx];
              if (v == null || !p) return "–";
              return `${p.lap ? `V${p.lap} · ` : ""}${fmtDuration(v * 60_000)}`;
            },
          },
          ...series.map(
            (s): uPlot.Series => ({
              label: s.tla,
              stroke: s.color,
              width: 2,
              spanGaps: false,
              points: { show: false },
              value: (_u, v) => (v == null ? "–" : `+${v.toFixed(1)} s`),
            }),
          ),
        ],
        cursor: { y: false, points: { size: 9 } },
        legend: { live: true },
        hooks: { draw: [(u) => drawEndLabels(u, series)] },
      },
      toData(history.current, series),
      el,
    );
    plot.current = u;
    const ro = new ResizeObserver(() => u.setSize({ width: el.clientWidth, height: 220 }));
    ro.observe(el);
    return () => {
      ro.disconnect();
      u.destroy();
      plot.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seriesKey]);

  useEffect(() => {
    plot.current?.setData(toData(history.current, series));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);

  return (
    <div className="panel chart">
      <h3>
        {race ? "Gap al líder" : "Diferencia con el mejor tiempo"} <span className="muted small">· segundos, por minuto de sesión en curso</span>
      </h3>
      {!series.length && <p className="empty">Elegí de 2 a 4 pilotos haciendo clic en la torre.</p>}
      {series.length > 0 && !hasData && <p className="empty">El gráfico empieza cuando arranca la sesión.</p>}
      <div ref={host} className={`chart-host ${hasData ? "" : "chart-hidden"}`} />
    </div>
  );
});
