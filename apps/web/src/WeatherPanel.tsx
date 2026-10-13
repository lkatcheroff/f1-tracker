import type { WeatherSample } from "@f1/core";

const COMPASS = ["N", "NE", "E", "SE", "S", "SO", "O", "NO"];
const compass = (deg: number) => COMPASS[Math.round(deg / 45) % 8];
const fmt = (v: number | null, digits = 1, unit = "") => (v === null ? "–" : `${v.toFixed(digits).replace(".", ",")}${unit}`);

/** Cuánto cambió respecto de hace ~10 minutos: sube, baja o estable (con tolerancia, para no marcar ruido). */
function trend(samples: WeatherSample[], pick: (s: WeatherSample) => number | null, tol: number): "▲" | "▼" | "=" | "" {
  const last = samples[samples.length - 1];
  const cur = pick(last);
  if (cur === null) return "";
  const before = [...samples].reverse().find((s) => s.ts <= last.ts - 10 * 60_000 && pick(s) !== null);
  const prev = before ? pick(before) : null;
  if (prev === null) return "";
  return cur - prev > tol ? "▲" : prev - cur > tol ? "▼" : "=";
}

/** Dibuja temperatura de pista (línea llena) y de aire (punteada) con la lluvia como franjas. */
function Spark({ samples }: { samples: WeatherSample[] }) {
  const W = 300;
  const H = 56;
  const t0 = samples[0].ts;
  const span = Math.max(1, samples[samples.length - 1].ts - t0);
  const values = samples
    .flatMap((s) => [s.track, s.air])
    .filter((v): v is number => v !== null)
    .sort((a, b) => a - b);
  if (values.length < 2) return null;
  // La escala sale de los percentiles 2 y 98: una lectura errónea suelta no debe aplastar el resto del gráfico.
  const lo = values[Math.floor(values.length * 0.02)] - 1;
  const hi = values[Math.ceil(values.length * 0.98) - 1] + 1;
  const x = (ts: number) => ((ts - t0) / span) * W;
  const y = (v: number) => Math.max(0, Math.min(H, H - ((v - lo) / (hi - lo)) * H));
  const line = (pick: (s: WeatherSample) => number | null) =>
    samples
      .filter((s) => pick(s) !== null)
      .map((s) => `${x(s.ts).toFixed(1)},${y(pick(s) as number).toFixed(1)}`)
      .join(" ");
  const rain: { from: number; to: number }[] = [];
  samples.forEach((s, i) => {
    if (!s.rain) return;
    const next = samples[i + 1]?.ts ?? s.ts;
    const last = rain[rain.length - 1];
    if (last && last.to >= s.ts) last.to = next;
    else rain.push({ from: s.ts, to: next });
  });
  return (
    <svg
      className="wx-spark"
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      role="img"
      aria-label="Temperatura de pista y de aire durante la sesión; las franjas azules son lluvia"
    >
      {rain.map((r) => (
        <rect key={r.from} x={x(r.from)} y={0} width={Math.max(2, x(r.to) - x(r.from))} height={H} fill="var(--blue)" opacity="0.28" />
      ))}
      <polyline points={line((s) => s.track)} fill="none" stroke="var(--orange)" strokeWidth="2" vectorEffect="non-scaling-stroke" />
      <polyline
        points={line((s) => s.air)}
        fill="none"
        stroke="var(--ink-2)"
        strokeWidth="2"
        strokeDasharray="5 4"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

/** El clima de la pista hasta el momento que se está viendo. */
export function WeatherPanel({ samples }: { samples: WeatherSample[] }) {
  if (!samples.length) return null;
  const w = samples[samples.length - 1];
  const cell = (label: string, value: string, extra = "") => (
    <div className="wx-cell">
      <span className="wx-label">{label}</span>
      <span className="wx-value">
        {value}
        {extra && <span className="wx-trend"> {extra}</span>}
      </span>
    </div>
  );
  return (
    <section className="panel wx" aria-label="Clima">
      <h3>Clima {w.rain && <span className="wx-rain">☂ Lluvia</span>}</h3>
      <div className="wx-grid">
        {cell(
          "Pista",
          fmt(w.track, 1, "°"),
          trend(samples, (s) => s.track, 0.5),
        )}
        {cell(
          "Aire",
          fmt(w.air, 1, "°"),
          trend(samples, (s) => s.air, 0.5),
        )}
        {cell(
          "Humedad",
          fmt(w.humidity, 0, " %"),
          trend(samples, (s) => s.humidity, 2),
        )}
        {cell("Viento", w.windSpeed === null ? "–" : `${fmt(w.windSpeed, 1)} m/s${w.windDir !== null ? ` · ${compass(w.windDir)}` : ""}`)}
        {cell("Presión", fmt(w.pressure, 0, " hPa"))}
      </div>
      {samples.length > 2 && (
        <>
          <Spark samples={samples} />
          <p className="wx-legend muted small">
            <span className="wx-key wx-key-track" /> Pista <span className="wx-key wx-key-air" /> Aire{" "}
            <span className="wx-key wx-key-rain" /> Lluvia
          </p>
        </>
      )}
    </section>
  );
}
