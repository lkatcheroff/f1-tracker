import { parseGap, parseLapTime, type DriverRow, type RaceControlMessage, type Snapshot, type TrackOutline } from "@f1/core";
import { memo, useMemo } from "react";
import type { CircuitInfo } from "./circuit";
import { centroidOf, longStraights, nearestIndex, outwardNormal, projector, slicePoints } from "./mapGeometry";

type XY = [number, number];
type Tone = "green" | "yellow" | "orange" | "red" | undefined;

interface Props {
  outline: TrackOutline | null;
  circuit: CircuitInfo | null;
  snap: Snapshot;
  /** tono del estado de pista (amarilla, Safety Car, roja): tiñe el trazado */
  tone: Tone;
  /** sin animación entre muestras (reproducción rápida o salto) */
  instant: boolean;
  /** Si el feed no manda posiciones, por qué. */
  missingReason: string | null;
}

const BLUE_FLAG_MS = 20_000;
const ATTACK_GAP_S = 1;

const pathOf = (pts: XY[], close = false) => `M${pts.map(([x, y]) => `${x.toFixed(0)},${y.toFixed(0)}`).join("L")}${close ? "Z" : ""}`;
const rcTime = (m: RaceControlMessage) => Date.parse(/Z$/.test(m.utc) ? m.utc : `${m.utc}Z`);

/** Dónde volvería a pista si parara ahora: su gap más lo que cuesta la parada, contra los gaps del resto. */
function rejoin(d: DriverRow, drivers: DriverRow[], loss: number): string {
  if (d.gapSec === null) return "";
  const after = d.gapSec + loss;
  const ahead = drivers.filter((o) => o.num !== d.num && o.gapSec !== null && !o.retired && !o.stopped && o.gapSec < after).length;
  return ` · si para ahora sale P${ahead + 1} (pierde ~${loss.toFixed(0)} s)`;
}

export const TrackMap = memo(function TrackMap({ outline, circuit, snap, tone, instant, missingReason }: Props) {
  const { drivers, raceControl, yellowSectors } = snap;
  const race = snap.lap !== null;
  const cars = drivers.filter((d) => d.xy);
  const project = useMemo(() => projector(circuit?.rotation ?? 0), [circuit]);

  // Todo lo que no se mueve: trazado, meta, sectores, rectas, curvas y boxes. Se recalcula solo si cambia el circuito.
  const base = useMemo(() => {
    if (!outline) return null;
    const pts = outline.points.map(([x, y]) => project(x, y));
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of pts) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    const unit = Math.hypot(maxX - minX, maxY - minY) / 100;
    const centroid = centroidOf(pts);

    /** Marca perpendicular a la pista en el punto `i`, con su etiqueta del lado de afuera. */
    const tick = (i: number, half: number, labelAt: number) => {
      const [nx, ny] = outwardNormal(pts, i, centroid);
      const [x, y] = pts[i];
      return {
        d: `M${x - nx * half},${y - ny * half}L${x + nx * half},${y + ny * half}`,
        label: [x + nx * labelAt, y + ny * labelAt] as XY,
      };
    };
    const sectorTick = (raw: XY | undefined) => (raw ? tick(nearestIndex(pts, project(raw[0], raw[1])), unit * 1.8, unit * 4.2) : null);

    // Flecha de sentido de giro, al costado de la pista pasando la salida de boxes.
    const ai = Math.min(pts.length - 3, Math.round(pts.length * 0.07) + 2);
    const [anx, any] = outwardNormal(pts, ai, centroid);
    const adx = pts[ai + 2][0] - pts[ai - 2][0];
    const ady = pts[ai + 2][1] - pts[ai - 2][1];
    const al = Math.hypot(adx, ady) || 1;
    const [ux, uy] = [adx / al, ady / al];
    const [ax, ay] = [pts[ai][0] + anx * unit * 3, pts[ai][1] + any * unit * 3];
    const arrow = `M${ax + ux * unit * 1.8},${ay + uy * unit * 1.8}L${ax - ux * unit + -uy * unit * 1.1},${ay - uy * unit + ux * unit * 1.1}L${ax - ux * unit + uy * unit * 1.1},${ay - uy * unit - ux * unit * 1.1}Z`;

    // Calle de boxes: la meta suele quedar entre la entrada y la salida, así que sus etiquetas
    // van del lado de adentro del circuito y la de META, del lado de afuera.
    const pitPts = outline.pit?.map(([x, y]) => project(x, y));
    const pitEnd = (p: XY) => {
      const [nx, ny] = outwardNormal(pts, nearestIndex(pts, p), centroid);
      return { at: p, label: [p[0] - nx * unit * 3.6, p[1] - ny * unit * 3.6] as XY };
    };

    return {
      pts,
      unit,
      viewBox: `${minX - unit * 10} ${minY - unit * 10} ${maxX - minX + unit * 20} ${maxY - minY + unit * 20}`,
      track: pathOf(pts, true),
      finish: tick(0, unit * 2.4, unit * 5),
      arrow,
      s2: sectorTick(outline.marks?.s2),
      s3: sectorTick(outline.marks?.s3),
      straights: longStraights(pts).map((r) => pathOf(slicePoints(pts, r.from, r.to))),
      pit: pitPts ? { d: pathOf(pitPts), entry: pitEnd(pitPts[0]), exit: pitEnd(pitPts[pitPts.length - 1]) } : null,
      corners: (circuit?.corners ?? []).map((c) => {
        const a = (c.angle * Math.PI) / 180;
        const off = unit * 4; // la proyección solo rota, así que la distancia vale igual en unidades del feed
        return {
          label: `${c.number}${c.letter ?? ""}`,
          at: project(c.trackPosition.x + Math.cos(a) * off, c.trackPosition.y + Math.sin(a) * off),
        };
      }),
    };
  }, [outline, circuit, project]);

  if (!base && !cars.length) {
    return (
      <div className="panel map">
        <h3>Mapa</h3>
        <p className="empty">{missingReason ?? "Esperando posiciones…"}</p>
      </div>
    );
  }

  // Sin trazado todavía: el encuadre sigue a los autos.
  let unit = base?.unit ?? 0;
  let viewBox = base?.viewBox ?? "";
  const at = (xy: XY) => project(xy[0], xy[1]);
  if (!base) {
    const ps = cars.map((d) => at(d.xy!));
    const xs = ps.map((p) => p[0]);
    const ys = ps.map((p) => p[1]);
    const w = Math.max(Math.max(...xs) - Math.min(...xs), 1000);
    const h = Math.max(Math.max(...ys) - Math.min(...ys), 1000);
    unit = Math.hypot(w, h) / 100;
    viewBox = `${Math.min(...xs) - unit * 10} ${Math.min(...ys) - unit * 10} ${w + unit * 20} ${h + unit * 20}`;
  }

  const yellows = circuit
    ? yellowSectors.flatMap((y) => {
        const m = circuit.marshalSectors.find((s) => s.number === y.sector);
        return m ? [{ ...y, at: project(m.trackPosition.x, m.trackPosition.y) }] : [];
      })
    : [];

  // --- lo que cuenta la carrera en este instante ---
  const neutralised = tone === "orange" || tone === "red";
  const started = snap.status === "Started";
  const blue = new Set(
    snap.utc === null
      ? []
      : raceControl.filter((m) => m.flag === "BLUE" && m.driver && snap.utc! - rcTime(m) >= 0 && snap.utc! - rcTime(m) < BLUE_FLAG_MS).map((m) => m.driver!),
  );
  let fastest: string | null = null;
  if (race) {
    let best = Infinity;
    for (const d of drivers) {
      const t = parseLapTime(d.bestLap);
      if (t !== null && t < best) [best, fastest] = [t, d.num];
    }
  }
  const overtake = [...raceControl].reverse().find((m) => /^OVERTAKE (ENABLED|DISABLED)/.test(m.message));
  const loss = circuit?.pitLoss ? Number(tone === "orange" ? (snap.track.status === "4" ? circuit.pitLoss.sc : circuit.pitLoss.vsc) : circuit.pitLoss.normal) : NaN;

  const view = cars.map((d) => {
    const parked = (d.stopped || d.retired) && !d.inPit;
    const running = !parked && d.onTrack && !d.inPit;
    const interval = parseGap(d.interval);
    const state = race ? null : d.lapState;
    return {
      d,
      parked,
      running,
      leader: race && d.position === 1 && !parked,
      attacking: race && started && !neutralised && running && d.position > 1 && interval !== null && interval > 0 && interval < ATTACK_GAP_S,
      fastest: race && started && d.num === fastest && !parked,
      blue: blue.has(d.num),
      state,
    };
  });
  const any = (f: (v: (typeof view)[number]) => boolean) => view.some(f);

  const tip = (v: (typeof view)[number]) => {
    const { d } = v;
    const parts = [`P${d.position} ${d.name} · ${d.team}`];
    if (v.parked) parts.push("detenido en pista");
    else if (d.inPit) parts.push("en boxes");
    if (d.gap) parts.push(`gap ${d.gap}`);
    if (d.interval && d.position > 1) parts.push(`intervalo ${d.interval}`);
    if (d.tyre) parts.push(`${d.tyre.compound.toLowerCase()} de ${d.tyre.age} vueltas`);
    if (d.lastLap.value) parts.push(`última ${d.lastLap.value}`);
    let text = parts.join(" · ");
    if (race && started && v.running && Number.isFinite(loss)) text += rejoin(d, drivers, loss);
    return text;
  };

  return (
    <div className="panel map">
      <h3>
        Mapa
        {!outline && <span className="muted small"> · armando el trazado con la primera vuelta limpia</span>}
        {overtake && (
          <span className={`map-chip ${overtake.message.includes("ENABLED") ? "chip-on" : ""}`}>
            Overtake {overtake.message.includes("ENABLED") ? "habilitado" : "deshabilitado"}
          </span>
        )}
      </h3>
      <svg viewBox={viewBox} className={instant ? "instant" : ""} role="img" aria-label="Posición de los autos en pista">
        {base && (
          <>
            <path d={base.track} className="track-edge" strokeWidth={unit * 2.6} />
            <path d={base.track} className={`track-line ${tone && tone !== "green" ? `tone-${tone}` : ""}`} strokeWidth={unit * 1.5} />
            {!neutralised && base.straights.map((d, i) => <path key={i} d={d} className="track-straight" strokeWidth={unit * 1.5} />)}
            {base.pit && (
              <>
                <path d={base.pit.d} className="pit-lane" strokeWidth={unit * 0.55} strokeDasharray={`${unit * 1.1} ${unit * 0.9}`} />
                {[
                  { e: base.pit.entry, label: "Entrada" },
                  { e: base.pit.exit, label: "Salida" },
                ].map(({ e, label }) => (
                  <g key={label}>
                    <circle cx={e.at[0]} cy={e.at[1]} r={unit * 0.9} className="pit-end" strokeWidth={unit * 0.4} />
                    <text x={e.label[0]} y={e.label[1]} fontSize={unit * 1.9} className="map-label map-pit-label" strokeWidth={unit * 0.5}>
                      {label}
                    </text>
                  </g>
                ))}
              </>
            )}
            {base.corners.map((c) => (
              <text key={c.label} x={c.at[0]} y={c.at[1]} fontSize={unit * 2.1} className="map-corner" strokeWidth={unit * 0.5}>
                {c.label}
              </text>
            ))}
            {[
              { t: base.s2, label: "S2" },
              { t: base.s3, label: "S3" },
            ].map(
              ({ t, label }) =>
                t && (
                  <g key={label}>
                    <path d={t.d} className="map-sector" strokeWidth={unit * 0.5} />
                    <text x={t.label[0]} y={t.label[1]} fontSize={unit * 2.1} className="map-label" strokeWidth={unit * 0.5}>
                      {label}
                    </text>
                  </g>
                ),
            )}
            <path d={base.finish.d} className="map-finish" strokeWidth={unit * 0.9} />
            <path d={base.finish.d} className="map-finish-check" strokeWidth={unit * 0.9} strokeDasharray={`${unit * 0.8} ${unit * 0.8}`} />
            <text x={base.finish.label[0]} y={base.finish.label[1]} fontSize={unit * 2.1} className="map-label" strokeWidth={unit * 0.5}>
              META
            </text>
            <path d={base.arrow} className="map-arrow" />
          </>
        )}

        {yellows.map((y) => (
          <g key={y.sector} className="map-yellow" style={{ transform: `translate(${y.at[0]}px, ${y.at[1]}px)` }}>
            <circle r={unit * 3.2} className="map-yellow-halo" />
            <path d={`M0,${-unit * 2}L${unit * 1.8},${unit * 1.2}L${-unit * 1.8},${unit * 1.2}Z`} strokeWidth={unit * 0.3} />
            <text y={unit * 0.75} fontSize={unit * 1.9}>
              {y.double ? "!!" : "!"}
            </text>
          </g>
        ))}

        {/* el líder se dibuja último para quedar arriba */}
        {[...view].reverse().map((v) => {
          const { d } = v;
          const [x, y] = at(d.xy!);
          const hot = v.state === "purple" || v.state === "green";
          const ringed = v.leader || v.attacking || v.blue || hot;
          const out = v.state === "out";
          return (
            <g key={d.num} className={`car ${v.running || v.parked ? "" : "car-off"}`} style={{ transform: `translate(${x}px, ${y}px)` }}>
              <title>{tip(v)}</title>
              {v.leader && <circle r={unit * 2.7} className="car-ring ring-leader" strokeWidth={unit * 0.5} />}
              {v.attacking && (
                <circle r={unit * 2.7} className="car-ring ring-attack" strokeWidth={unit * 0.55} strokeDasharray={`${unit * 1.2} ${unit * 0.7}`} />
              )}
              {v.blue && <circle r={unit * (v.attacking ? 3.5 : 2.7)} className="car-ring ring-blue" strokeWidth={unit * 0.55} />}
              {hot && <circle r={unit * 2.5} className={`car-ring ring-${v.state}`} strokeWidth={unit * 0.55} />}
              {(v.state === "purple" || v.fastest) && <circle r={unit * 3.5} className="car-ring ring-purple" strokeWidth={unit * 0.35} />}
              {v.parked ? (
                <>
                  <circle r={unit * 1.9} className="car-parked" strokeWidth={unit * 0.35} />
                  <path
                    d={`M${-unit},${-unit}L${unit},${unit}M${unit},${-unit}L${-unit},${unit}`}
                    stroke={`#${d.color}`}
                    strokeWidth={unit * 0.7}
                    strokeLinecap="round"
                  />
                </>
              ) : (
                <circle
                  r={unit * 1.5}
                  fill={out ? "var(--surface)" : `#${d.color}`}
                  stroke={out ? `#${d.color}` : undefined}
                  className="car-dot"
                  strokeWidth={unit * (out ? 0.6 : 0.35)}
                />
              )}
              <text y={-unit * (v.fastest || v.state === "purple" ? 4.3 : ringed ? 3.5 : 2.4)} fontSize={unit * 2.4} className="car-label" strokeWidth={unit * 0.6}>
                {v.leader ? `P1 ${d.tla}` : d.tla}
              </text>
            </g>
          );
        })}

        {snap.safetyCars.map((c) => {
          const [x, y] = at(c.xy);
          return (
            <g key={c.id} className="car safety-car" style={{ transform: `translate(${x}px, ${y}px)` }}>
              <title>{c.id === "241" ? "Safety Car" : "Auto de seguridad"}</title>
              <rect x={-unit * 2.6} y={-unit * 1.6} width={unit * 5.2} height={unit * 3.2} rx={unit * 0.8} strokeWidth={unit * 0.35} />
              <text y={unit * 0.75} fontSize={unit * 2.2}>
                {c.id === "241" ? "SC" : "FIA"}
              </text>
            </g>
          );
        })}
      </svg>

      <ul className="map-legend">
        {base && (
          <li>
            <svg viewBox="0 0 16 10" className="key">
              <path d="M8,0V10" className="map-finish" strokeWidth="3" />
              <path d="M8,0V10" className="map-finish-check" strokeWidth="3" strokeDasharray="2.5 2.5" />
            </svg>
            Meta y sentido de giro
          </li>
        )}
        {(base?.s2 || base?.s3) && (
          <li>
            <svg viewBox="0 0 16 10" className="key">
              <path d="M8,1V9" className="map-sector" strokeWidth="1.5" />
            </svg>
            Inicio de sector
          </li>
        )}
        {!!base?.corners.length && (
          <li>
            <span className="key key-text">7</span>Curva
          </li>
        )}
        {base?.pit && (
          <li>
            <svg viewBox="0 0 16 10" className="key">
              <path d="M1,5H15" className="pit-lane" strokeWidth="1.6" strokeDasharray="3 2" />
            </svg>
            Calle de boxes, con entrada y salida
          </li>
        )}
        {!!base?.straights.length && !neutralised && (
          <li title="El feed de F1 no publica zonas de sobrepaso. Se marcan las rectas más largas del trazado, donde suelen darse.">
            <svg viewBox="0 0 16 10" className="key">
              <path d="M1,5H15" className="track-straight" strokeWidth="4" />
            </svg>
            Recta larga: zona típica de sobrepaso (estimada)
          </li>
        )}
        {any((v) => v.leader) && (
          <li>
            <svg viewBox="0 0 16 10" className="key">
              <circle cx="8" cy="5" r="4" className="car-ring ring-leader" strokeWidth="1.2" />
              <circle cx="8" cy="5" r="2" fill="var(--ink-2)" />
            </svg>
            Líder
          </li>
        )}
        {any((v) => v.attacking) && (
          <li>
            <svg viewBox="0 0 16 10" className="key">
              <circle cx="8" cy="5" r="4" className="car-ring ring-attack" strokeWidth="1.2" strokeDasharray="2.4 1.4" />
              <circle cx="8" cy="5" r="2" fill="var(--ink-2)" />
            </svg>
            A menos de 1 s del de adelante
          </li>
        )}
        {any((v) => v.fastest) && (
          <li>
            <svg viewBox="0 0 16 10" className="key">
              <circle cx="8" cy="5" r="4.4" className="car-ring ring-purple" strokeWidth="0.8" />
              <circle cx="8" cy="5" r="2" fill="var(--ink-2)" />
            </svg>
            Vuelta rápida de la carrera
          </li>
        )}
        {any((v) => v.state === "purple") && (
          <li>
            <svg viewBox="0 0 16 10" className="key">
              <circle cx="8" cy="5" r="4.4" className="car-ring ring-purple" strokeWidth="0.7" />
              <circle cx="8" cy="5" r="3" className="car-ring ring-purple" strokeWidth="1.1" />
              <circle cx="8" cy="5" r="1.5" fill="var(--ink-2)" />
            </svg>
            Vuelta con récord de sector
          </li>
        )}
        {any((v) => v.state === "green") && (
          <li>
            <svg viewBox="0 0 16 10" className="key">
              <circle cx="8" cy="5" r="4" className="car-ring ring-green" strokeWidth="1.2" />
              <circle cx="8" cy="5" r="2" fill="var(--ink-2)" />
            </svg>
            Vuelta mejorando su marca
          </li>
        )}
        {any((v) => v.state === "out") && (
          <li>
            <svg viewBox="0 0 16 10" className="key">
              <circle cx="8" cy="5" r="3" fill="none" stroke="var(--ink-2)" strokeWidth="1.4" />
            </svg>
            Vuelta de salida o de entrada
          </li>
        )}
        {any((v) => v.blue) && (
          <li>
            <svg viewBox="0 0 16 10" className="key">
              <circle cx="8" cy="5" r="4" className="car-ring ring-blue" strokeWidth="1.2" />
              <circle cx="8" cy="5" r="2" fill="var(--ink-2)" />
            </svg>
            Bandera azul
          </li>
        )}
        {any((v) => v.parked) && (
          <li>
            <svg viewBox="0 0 16 10" className="key">
              <path d="M5,2L11,8M11,2L5,8" stroke="var(--ink-2)" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
            Auto detenido en pista
          </li>
        )}
        {!!snap.safetyCars.length && (
          <li>
            <span className="key key-sc">SC</span>Safety Car
          </li>
        )}
        {!!yellows.length && (
          <li>
            <svg viewBox="0 0 16 10" className="key">
              <path d="M8,0.5L13,9.5L3,9.5Z" fill="var(--yellow)" />
            </svg>
            Bandera amarilla
          </li>
        )}
      </ul>
      {race && circuit?.pitLoss && (
        <p className="map-note">
          Una parada cuesta ~{Number(circuit.pitLoss.normal).toFixed(0)} s (~{Number(circuit.pitLoss.sc).toFixed(0)} s con Safety Car). Pasá el mouse por un auto
          para ver dónde saldría si parara ahora.
        </p>
      )}
    </div>
  );
});
