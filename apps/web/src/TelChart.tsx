import { memo, useEffect, useRef } from "react";
import uPlot from "uplot";

/** Piloto A y referencia: slots 1 y 2 de la paleta categórica, validados para daltonismo sobre fondo oscuro. */
export const COLOR_A = "#3987e5";
export const COLOR_REF = "#d95926";

const INK = "#f4f4f1";
const INK_2 = "#a8a79f";
const GRID = "#2c2c29";

export interface Marker {
  /** metros desde la meta */
  x: number;
  label: string;
  /** las curvas son tenues; la meta y los sectores, más marcados */
  strong: boolean;
}

interface Props {
  /** [distancia, piloto A, referencia] */
  data: (number | null)[][];
  height: number;
  length: number;
  markers: Marker[];
  /** dibuja los números de curva arriba del gráfico */
  labelMarkers?: boolean;
  stepped?: boolean;
  /** línea de cero más marcada (para la diferencia de tiempo) */
  zero?: boolean;
  showXAxis?: boolean;
  /** rango del eje Y a partir de los datos */
  range?: (min: number, max: number) => [number, number];
  fmtY?: (v: number) => string;
  /** el gráfico que informa la posición del cursor (el resto lo sigue por `sync`) */
  onCursor?: (idx: number | null) => void;
}

/** Un gráfico de telemetría contra la distancia. Todos comparten cursor, así que se leen en vertical. */
export const TelChart = memo(function TelChart(props: Props) {
  const host = useRef<HTMLDivElement>(null);
  const plot = useRef<uPlot | null>(null);
  // Lo que el dibujo necesita leer en cada frame va por ref: así no hay que recrear el gráfico.
  const live = useRef(props);
  live.current = props;

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const { stepped, showXAxis, fmtY } = live.current;
    const stepPath = stepped ? uPlot.paths.stepped?.({ align: 1 }) : undefined;
    const series = (stroke: string, width: number): uPlot.Series => ({
      stroke,
      width,
      spanGaps: false,
      points: { show: false },
      ...(stepPath ? { paths: stepPath } : {}),
    });
    const u = new uPlot(
      {
        width: el.clientWidth,
        height: live.current.height,
        padding: [live.current.labelMarkers ? 14 : 4, 12, 0, 0],
        legend: { show: false },
        cursor: { y: false, drag: { x: false, y: false }, points: { size: 7 }, sync: { key: "telemetry", setSeries: false } },
        scales: {
          x: { time: false, range: () => [0, live.current.length] },
          y: { range: (_u, min, max) => (live.current.range ? live.current.range(min ?? 0, max ?? 1) : [min ?? 0, max ?? 1]) },
        },
        axes: [
          {
            show: !!showXAxis,
            stroke: INK_2,
            size: showXAxis ? 30 : 0,
            grid: { stroke: GRID, width: 1 },
            ticks: { stroke: GRID, width: 1 },
            values: (_u, vals) => vals.map((v) => `${Math.round(v)} m`),
          },
          {
            stroke: INK_2,
            size: 54,
            grid: { stroke: GRID, width: 1 },
            ticks: { stroke: GRID, width: 1 },
            values: (_u, vals) => vals.map((v) => (fmtY ? fmtY(v) : String(v))),
          },
        ],
        series: [{}, series(COLOR_A, 2), series(COLOR_REF, 1.5)],
        hooks: {
          setCursor: [(g) => live.current.onCursor?.(g.cursor.idx ?? null)],
          draw: [
            (g) => {
              const { markers, labelMarkers, zero } = live.current;
              const px = devicePixelRatio || 1;
              const ctx = g.ctx;
              const { left, top, width, height } = g.bbox;
              ctx.save();
              ctx.beginPath();
              ctx.rect(left, top, width, height);
              ctx.clip();
              for (const m of markers) {
                const x = g.valToPos(m.x, "x", true);
                ctx.strokeStyle = m.strong ? "rgba(244,244,241,0.38)" : "rgba(244,244,241,0.1)";
                ctx.lineWidth = (m.strong ? 1.5 : 1) * px;
                ctx.beginPath();
                ctx.moveTo(x, top);
                ctx.lineTo(x, top + height);
                ctx.stroke();
              }
              if (zero) {
                const y = g.valToPos(0, "y", true);
                ctx.strokeStyle = "rgba(244,244,241,0.55)";
                ctx.lineWidth = px;
                ctx.beginPath();
                ctx.moveTo(left, y);
                ctx.lineTo(left + width, y);
                ctx.stroke();
              }
              ctx.restore();
              if (labelMarkers) {
                ctx.save();
                ctx.font = `${10 * px}px system-ui, sans-serif`;
                ctx.textAlign = "center";
                ctx.textBaseline = "bottom";
                // En las zonas lentas las curvas están pegadas: se omite el número que pisaría al anterior.
                let lastRight = -Infinity;
                for (const m of markers) {
                  const px0 = g.valToPos(m.x, "x", true);
                  const half = ctx.measureText(m.label).width / 2;
                  if (px0 - half < lastRight + 3 * px && !m.strong) continue;
                  ctx.fillStyle = m.strong ? INK : INK_2;
                  ctx.fillText(m.label, px0, top - 2 * px);
                  lastRight = px0 + half;
                }
                ctx.restore();
              }
            },
          ],
        },
      },
      props.data as uPlot.AlignedData,
      el,
    );
    plot.current = u;
    const ro = new ResizeObserver(() => u.setSize({ width: el.clientWidth, height: live.current.height }));
    ro.observe(el);
    return () => {
      ro.disconnect();
      u.destroy();
      plot.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    plot.current?.setData(props.data as uPlot.AlignedData);
  }, [props.data, props.markers, props.length]);

  return <div ref={host} className="tel-chart" />;
});
