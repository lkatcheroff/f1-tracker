import {
  bestLap,
  currentLap,
  cutDrivers,
  deltaSeries,
  distanceAxis,
  indexOutline,
  lapPool,
  type OrderRow,
  projectOnOutline,
  type RefSpec,
  resolveRef,
  rivalOf,
  type SessionTelemetry,
  type Snapshot,
  sectorTimes,
  type TelemetryLap,
  type TrackOutline,
  topSpeeds,
} from "@f1/core";
import { useEffect, useMemo, useState } from "react";
import type { CircuitInfo } from "./circuit";
import { fmtDelta, fmtLapMs, fmtSecMs, store } from "./format";
import { COLOR_A, COLOR_REF, type Marker, TelChart } from "./TelChart";
import { useTelemetry } from "./useTelemetry";

interface Props {
  source: string;
  snap: Snapshot;
  outline: TrackOutline | null;
  circuit: CircuitInfo | null;
  spoilerFree: boolean;
}

/** Telemetría y comparación de vueltas. Se abre a pedido: la telemetría pesa 1 a 2 MB. */
export function TelemetryPanel({ source, snap, outline, circuit, spoilerFree }: Props) {
  const [open, setOpen] = useState(() => store.get("f1t:telOpen", false));
  useEffect(() => store.set("f1t:telOpen", open), [open]);
  const state = useTelemetry(open ? source : null);
  const unavailable = source.startsWith("openf1:")
    ? "Las sesiones que se cargan directo desde OpenF1 en el navegador no traen telemetría. Cuando el sitio publica la sesión (unas horas después de terminar), la telemetría aparece sola."
    : "Esta sesión no tiene telemetría.";

  return (
    <section className="panel telemetry">
      <div className="tel-head">
        <h3>Telemetría y comparación</h3>
        <button type="button" className="btn" onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? "Cerrar" : "Abrir"}
        </button>
      </div>
      {!open && (
        <p className="chart-note">
          Compará una vuelta con la mejor de la sesión, con el corte de clasificación o con cualquier rival, viendo en qué parte de la pista
          se gana o se pierde el tiempo.
        </p>
      )}
      {open && state.status === "loading" && <p className="empty">Bajando la telemetría…</p>}
      {open && state.status === "missing" && <p className="empty">{unavailable}</p>}
      {open && state.status === "error" && <p className="empty">No se pudo cargar la telemetría: {state.message}</p>}
      {open && state.status === "ready" && (
        <Body tel={state.data} snap={snap} outline={outline} circuit={circuit} spoilerFree={spoilerFree} />
      )}
    </section>
  );
}

const KIND_TAG: Record<string, string> = { in: " · entrada a boxes", out: " · salida de boxes", both: " · boxes", start: " · largada" };
const lapOption = (l: TelemetryLap) => `V${l.n} · ${fmtLapMs(l.ms)}${KIND_TAG[l.kind] ?? ""}`;

function Body({ tel, snap, outline, circuit, spoilerFree }: Omit<Props, "source"> & { tel: SessionTelemetry }) {
  const order: OrderRow[] = snap.drivers.map((d) => ({
    num: d.num,
    tla: d.tla,
    team: d.team,
    knockedOut: d.knockedOut,
    retired: d.retired,
  }));
  const tla = (num: string) => order.find((d) => d.num === num)?.tla ?? num;

  const [aNum, setANum] = useState<string | null>(null);
  const [aChoice, setAChoice] = useState<"live" | "best" | number>("live");
  const [refSpec, setRefSpec] = useState<RefSpec | null>(null);
  const [cursor, setCursor] = useState<number | null>(null);

  const a = aNum ?? order[0]?.num ?? "";
  const ctx = { tel, now: snap.time, spoilerFree, part: snap.part, through: snap.through, order };
  const pool = lapPool(ctx);
  const aPool = pool.filter((l) => l.d === a).sort((x, y) => x.n - y.n);
  const cur = currentLap(tel, a, snap.time);

  // La vuelta del piloto A: en curso (se va dibujando a medida que avanza), la mejor o una puntual.
  let lapA: TelemetryLap | null = null;
  let upto = tel.grid - 1;
  let note = "";
  if (aChoice === "live" && cur) {
    lapA = cur.lap;
    upto = cur.upto;
  } else if (typeof aChoice === "number") {
    lapA = aPool.find((l) => l.n === aChoice) ?? null;
  } else {
    lapA = bestLap(aPool);
    if (aChoice === "live") note = "Sin vuelta en curso (está en boxes o parado): se muestra su mejor vuelta.";
  }
  const live = !!lapA && aChoice === "live" && !!cur && cur.lap === lapA;

  // Referencia: por defecto, el corte en clasificación y la mejor de la sesión en el resto.
  const { firstOut } = cutDrivers(order, snap.through);
  const auto: RefSpec = snap.through && snap.part ? { kind: lapA && firstOut?.num === lapA.d ? "cut-in" : "cut-out" } : { kind: "best" };
  const spec = refSpec ?? auto;
  const ref = lapA ? resolveRef(ctx, lapA, spec) : null;
  const refLap = ref?.lap ?? null;

  const x = useMemo(() => distanceAxis(tel), [tel]);
  const speeds = useMemo(() => topSpeeds(pool, tel.length).slice(0, 8), [tel.length, pool]);
  const charts = useMemo(() => {
    const none = x.map(() => null);
    const clip = (arr?: number[]) => (arr ? arr.map((v, i) => (i <= upto ? v : null)) : none);
    const full = (arr?: number[]) => arr ?? none;
    return {
      delta: [x, clip(lapA && refLap ? deltaSeries(lapA, refLap) : undefined), none],
      speed: [x, clip(lapA?.v), full(refLap?.v)],
      throttle: [x, clip(lapA?.th), full(refLap?.th)],
      brake: [x, clip(lapA?.br), full(refLap?.br)],
      gear: [x, clip(lapA?.g), full(refLap?.g)],
    };
  }, [x, lapA, refLap, upto]);

  const ix = useMemo(() => (outline ? indexOutline(outline.points) : null), [outline]);
  const markers = useMemo<Marker[]>(() => {
    const m: Marker[] = [{ x: 0, label: "Meta", strong: true }];
    if (tel.marks)
      m.push({ x: tel.marks[0] * tel.length, label: "S2", strong: true }, { x: tel.marks[1] * tel.length, label: "S3", strong: true });
    if (circuit && ix) {
      for (const c of circuit.corners) {
        const p = projectOnOutline(ix, c.trackPosition.x, c.trackPosition.y);
        if (p && p.d < 1500) m.push({ x: p.f * tel.length, label: `${c.number}${c.letter ?? ""}`, strong: false });
      }
    }
    return m.sort((p, q) => p.x - q.x);
  }, [tel, circuit, ix]);

  const pickRival = (who: "teammate" | "ahead" | "behind") => {
    const r = rivalOf(order, a, who);
    if (r) setRefSpec({ kind: "driver", driver: r.num, lap: "best" });
  };
  const rivals = { teammate: rivalOf(order, a, "teammate"), ahead: rivalOf(order, a, "ahead"), behind: rivalOf(order, a, "behind") };
  const refDriverPool = spec.kind === "driver" && spec.driver ? pool.filter((l) => l.d === spec.driver).sort((p, q) => p.n - q.n) : [];

  // --- lecturas ---
  const i = Math.min(cursor ?? upto, upto);
  const delta = lapA && refLap ? (lapA.t[i] - refLap.t[i]) / 1000 : null;
  const secA = lapA ? sectorTimes(lapA, tel.marks) : null;
  const secR = refLap ? sectorTimes(refLap, tel.marks) : null;
  const ends = tel.marks ? [Math.round(tel.marks[0] * (tel.grid - 1)), Math.round(tel.marks[1] * (tel.grid - 1)), tel.grid - 1] : null;
  const done = (k: number) => !!ends && upto >= ends[k];
  const dist = Math.round(x[i] ?? 0);

  const readRow = (lap: TelemetryLap | null, color: string, name: string, clip: boolean) => {
    const ok = lap && (!clip || i <= upto);
    return (
      <tr>
        <td>
          <span className="swatch" style={{ background: color }} /> {name}
        </td>
        <td className="num">{ok ? `${lap!.v[i]} km/h` : "–"}</td>
        <td className="num">{ok ? `${lap!.th[i]} %` : "–"}</td>
        <td className="num">{ok ? (lap!.br[i] ? "frenando" : "–") : "–"}</td>
        <td className="num">{ok ? lap!.g[i] : "–"}</td>
        <td className="num">{ok ? `${(lap!.r[i] / 1000).toFixed(1)}k` : "–"}</td>
      </tr>
    );
  };

  const deltaClass = (v: number) => (v > 0.0005 ? "d-loss" : v < -0.0005 ? "d-gain" : "");

  return (
    <div className="tel-body">
      <div className="tel-controls">
        <label className="field">
          Piloto
          <select
            value={a}
            onChange={(e) => {
              setANum(e.target.value);
              setAChoice("live");
            }}
          >
            {order.map((d) => (
              <option key={d.num} value={d.num}>
                {d.tla}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Vuelta
          <select
            value={String(aChoice)}
            onChange={(e) => setAChoice(e.target.value === "live" || e.target.value === "best" ? e.target.value : Number(e.target.value))}
          >
            <option value="live">En curso{cur ? ` (V${cur.lap.n})` : ""}</option>
            <option value="best">Su mejor vuelta</option>
            {aPool.map((l) => (
              <option key={l.n} value={l.n}>
                {lapOption(l)}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Comparar con
          <select
            value={spec.kind}
            onChange={(e) => {
              const kind = e.target.value as RefSpec["kind"];
              setRefSpec(
                kind === "driver" ? { kind, driver: (rivals.teammate ?? rivals.ahead ?? rivals.behind)?.num, lap: "best" } : { kind },
              );
            }}
          >
            <option value="best">Mejor vuelta de la sesión</option>
            {snap.through && snap.part && <option value="cut-in">Último que pasa (P{snap.through})</option>}
            {snap.through && snap.part && <option value="cut-out">Primero eliminado (P{snap.through + 1})</option>}
            <option value="own">Su mejor vuelta</option>
            <option value="prev">Su vuelta anterior</option>
            <option value="driver">Otro piloto…</option>
          </select>
        </label>
        {spec.kind === "driver" && (
          <>
            <label className="field">
              Rival
              <select value={spec.driver ?? ""} onChange={(e) => setRefSpec({ kind: "driver", driver: e.target.value, lap: "best" })}>
                {order
                  .filter((d) => d.num !== a)
                  .map((d) => (
                    <option key={d.num} value={d.num}>
                      {d.tla}
                    </option>
                  ))}
              </select>
            </label>
            <label className="field">
              Su vuelta
              <select
                value={String(spec.lap ?? "best")}
                onChange={(e) => setRefSpec({ ...spec, lap: e.target.value === "best" ? "best" : Number(e.target.value) })}
              >
                <option value="best">Su mejor vuelta</option>
                {refDriverPool.map((l) => (
                  <option key={l.n} value={l.n}>
                    {lapOption(l)}
                  </option>
                ))}
              </select>
            </label>
          </>
        )}
      </div>

      <div className="tel-quick">
        <span className="muted small">Atajos:</span>
        {(
          [
            ["teammate", "Compañero de equipo"],
            ["ahead", "Auto de adelante"],
            ["behind", "Auto de atrás"],
          ] as const
        ).map(([who, label]) => (
          <button
            type="button"
            key={who}
            className={`btn btn-small ${spec.kind === "driver" && spec.driver === rivals[who]?.num ? "btn-on" : ""}`}
            disabled={!rivals[who]}
            onClick={() => pickRival(who)}
          >
            {label}
            {rivals[who] ? ` (${rivals[who]!.tla})` : ""}
          </button>
        ))}
        <button
          type="button"
          className={`btn btn-small ${refSpec === null ? "btn-on" : ""}`}
          onClick={() => setRefSpec(null)}
          title="Vuelve a la referencia que corresponde: el corte en clasificación, la mejor de la sesión en el resto"
        >
          Referencia automática
        </button>
      </div>

      {!lapA ? (
        <p className="empty">{tla(a)} todavía no completó una vuelta con telemetría.</p>
      ) : (
        <>
          <div className="tel-legend">
            <span>
              <span className="swatch" style={{ background: COLOR_A }} />
              <strong>{tla(lapA.d)}</strong> · V{lapA.n}
              {live ? ` en curso (${Math.round(((x[upto] ?? 0) / tel.length) * 100)} % de la vuelta)` : ` · ${fmtLapMs(lapA.ms)}`}
              {lapA.tyre ? ` · ${lapA.tyre.toLowerCase()}${lapA.age !== null ? ` de ${lapA.age} vueltas` : ""}` : ""}
            </span>
            <span>
              <span className="swatch" style={{ background: COLOR_REF }} />
              {refLap ? (
                <>
                  <strong>{ref!.label}</strong>
                  {refLap.tyre ? ` · ${refLap.tyre.toLowerCase()}` : ""}
                </>
              ) : (
                <span className="muted">{ref?.missing ?? "Sin referencia"}</span>
              )}
            </span>
            {delta !== null && (
              <span className={`tel-delta ${deltaClass(delta)}`}>
                {live && cursor === null ? "Ahora" : `A los ${dist} m`}: {fmtDelta(delta)} s
                <span className="muted small"> {delta > 0 ? `(${tla(lapA.d)} pierde)` : delta < 0 ? `(${tla(lapA.d)} gana)` : ""}</span>
              </span>
            )}
          </div>
          {note && <p className="chart-note">{note}</p>}

          <div className="tel-grid">
            <div className="tel-charts">
              <div className="tel-title">
                Diferencia de tiempo <span className="muted small">segundos · arriba, {tla(lapA.d)} pierde; abajo, gana</span>
              </div>
              <TelChart
                data={charts.delta}
                height={150}
                length={tel.length}
                markers={markers}
                labelMarkers
                zero
                onCursor={setCursor}
                range={(min, max) => [Math.min(min, -0.15) * 1.15, Math.max(max, 0.15) * 1.15]}
                fmtY={(v) => `${v > 0 ? "+" : ""}${v.toFixed(2)}`}
              />
              <div className="tel-title">
                Velocidad <span className="muted small">km/h</span>
              </div>
              <TelChart
                data={charts.speed}
                height={130}
                length={tel.length}
                markers={markers}
                range={(min, max) => [Math.max(0, min - 10), max + 10]}
                fmtY={(v) => String(Math.round(v))}
              />
              <div className="tel-title">
                Acelerador <span className="muted small">%</span>
              </div>
              <TelChart
                data={charts.throttle}
                height={90}
                length={tel.length}
                markers={markers}
                range={() => [-5, 105]}
                fmtY={(v) => (v >= 0 && v <= 100 ? String(Math.round(v)) : "")}
              />
              <div className="tel-title">Freno</div>
              <TelChart
                data={charts.brake}
                height={56}
                length={tel.length}
                markers={markers}
                stepped
                range={() => [-0.15, 1.15]}
                fmtY={(v) => (v === 1 ? "sí" : v === 0 ? "no" : "")}
              />
              <div className="tel-title">Marcha</div>
              <TelChart
                data={charts.gear}
                height={90}
                length={tel.length}
                markers={markers}
                stepped
                showXAxis
                range={(min, max) => [Math.max(0, min - 0.5), max + 0.5]}
                fmtY={(v) => (Number.isInteger(v) ? String(v) : "")}
              />
            </div>

            <aside className="tel-side">
              <table className="tel-table">
                <thead>
                  <tr>
                    <th>{cursor === null && live ? "Ahora" : `A los ${dist} m`}</th>
                    <th className="num">Velocidad</th>
                    <th className="num">Acel.</th>
                    <th className="num">Freno</th>
                    <th className="num">Marcha</th>
                    <th className="num">RPM</th>
                  </tr>
                </thead>
                <tbody>
                  {readRow(lapA, COLOR_A, tla(lapA.d), true)}
                  {readRow(refLap, COLOR_REF, refLap ? tla(refLap.d) : "Ref.", false)}
                </tbody>
              </table>

              <table className="tel-table">
                <thead>
                  <tr>
                    <th>Sectores</th>
                    {["S1", "S2", "S3", "Vuelta"].map((h) => (
                      <th key={h} className="num">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {[
                    { name: tla(lapA.d), color: COLOR_A, sec: secA, total: lapA.ms, clip: true },
                    { name: refLap ? tla(refLap.d) : "Ref.", color: COLOR_REF, sec: secR, total: refLap?.ms ?? null, clip: false },
                  ].map((r) => (
                    <tr key={r.name + r.color}>
                      <td>
                        <span className="swatch" style={{ background: r.color }} /> {r.name}
                      </td>
                      {[0, 1, 2].map((k) => (
                        <td key={k} className="num">
                          {r.sec && (!r.clip || done(k)) ? fmtSecMs(r.sec[k]) : "–"}
                        </td>
                      ))}
                      <td className="num">{r.total !== null && (!r.clip || upto >= tel.grid - 1) ? fmtLapMs(r.total) : "–"}</td>
                    </tr>
                  ))}
                  {secA && secR && (
                    <tr className="tel-diff">
                      <td>Diferencia</td>
                      {[0, 1, 2].map((k) => {
                        const d = (secA[k] - secR[k]) / 1000;
                        return (
                          <td key={k} className={`num ${done(k) ? deltaClass(d) : ""}`}>
                            {done(k) ? fmtDelta(d) : "–"}
                          </td>
                        );
                      })}
                      <td className={`num ${upto >= tel.grid - 1 ? deltaClass((lapA.ms - refLap!.ms) / 1000) : ""}`}>
                        {upto >= tel.grid - 1 ? fmtDelta((lapA.ms - refLap!.ms) / 1000) : "–"}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
              <table className="tel-table">
                <thead>
                  <tr>
                    <th>Velocidad máxima</th>
                    <th className="num">km/h</th>
                    <th className="num">Vuelta</th>
                    <th className="num">A los</th>
                  </tr>
                </thead>
                <tbody>
                  {speeds.map((t) => (
                    <tr key={t.driver} className={t.driver === a ? "tel-self" : ""}>
                      <td>{tla(t.driver)}</td>
                      <td className="num">{t.kmh}</td>
                      <td className="num">V{t.lap}</td>
                      <td className="num">{t.atM} m</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="chart-note">
                Máxima registrada por la telemetría, a unas 4 muestras por segundo: puede quedar unos km/h debajo de la trampa de velocidad.
              </p>
              <p className="chart-note">
                Los sectores salen de la traza de cada vuelta (suman el tiempo oficial). Rojo: {tla(lapA.d)} pierde tiempo en ese tramo;
                verde: lo gana. Las líneas verticales del gráfico son la meta, el inicio de S2 y S3 y los números de curva.
              </p>
            </aside>
          </div>
        </>
      )}
    </div>
  );
}
