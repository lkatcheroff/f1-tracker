import { activeBattles, neutralAt, PARAMS, type Params, projections, visible } from "@f1/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Controls } from "./Controls";
import { useCircuit } from "./circuit";
import { DataQualityNote } from "./DataQualityNote";
import { DominancePanel } from "./DominancePanel";
import { EventPanel } from "./EventPanel";
import { jumpTarget, neighbour, useEventFilter, useHighWater } from "./events";
import { fmtDuration, SESSION_STATUS, store, TRACK_STATUS } from "./format";
import { type ChartSeries, GapChart, SERIES_COLORS } from "./GapChart";
import { IdealPanel } from "./IdealPanel";
import { LivePanel } from "./LivePanel";
import { PHONE, useMediaQuery } from "./media";
import { PacePanel } from "./PacePanel";
import { RaceControl } from "./RaceControl";
import { RaceState } from "./RaceState";
import { TelemetryPanel } from "./TelemetryPanel";
import { Tower } from "./Tower";
import { TrackMap } from "./TrackMap";
import type { Target } from "./transport";
import { useTracker } from "./useTracker";

const MAX_SERIES = SERIES_COLORS.length;

type TabId = "tower" | "map" | "gaps" | "events" | "tel";
const TABS: { id: TabId; label: string; replayOnly?: boolean }[] = [
  { id: "tower", label: "Torre" },
  { id: "map", label: "Mapa" },
  { id: "gaps", label: "Gaps" },
  { id: "events", label: "Eventos" },
  { id: "tel", label: "Telemetría", replayOnly: true },
];

export function SessionView({ target }: { target: Target }) {
  const t = useTracker(target);
  const { snap, playback, live, index, send } = t;
  const source = target.mode === "replay" ? target.source : "live";

  const [spoilerFree, setSpoilerFree] = useState(() => store.get("f1t:spoilerFree", true));
  useEffect(() => store.set("f1t:spoilerFree", spoilerFree), [spoilerFree]);

  // En teléfono la vista se parte en pestañas (una columna con todo sería interminable).
  const phone = useMediaQuery(PHONE);
  const [tab, setTab] = useState<TabId>(() => store.get<TabId>("f1t:tab", "tower"));
  useEffect(() => store.set("f1t:tab", tab), [tab]);
  // Una pestaña guardada de otra sesión (la telemetría en un live) no existe acá: se vuelve a la torre.
  const shown: TabId = tab === "tel" && target.mode !== "replay" ? "tower" : tab;

  // Pilotos del gráfico: nº de auto → slot de color. El slot no cambia mientras el piloto siga elegido.
  const selKey = `f1t:sel:${source}`;
  const [sel, setSel] = useState<Record<string, number> | null>(() => store.get(selKey, null));
  useEffect(() => {
    if (sel) store.set(selKey, sel);
  }, [selKey, sel]);
  useEffect(() => {
    // Por defecto, los tres que siguen al líder (la línea del líder es siempre cero).
    if (sel === null && snap && snap.drivers.length >= 4) setSel(Object.fromEntries(snap.drivers.slice(1, 4).map((d, i) => [d.num, i])));
  }, [sel, snap]);

  const toggle = useCallback((num: string) => {
    setSel((cur) => {
      const next = { ...(cur ?? {}) };
      if (num in next) delete next[num];
      else {
        const used = new Set(Object.values(next));
        const slot = SERIES_COLORS.findIndex((_, i) => !used.has(i));
        if (slot === -1 || used.size >= MAX_SERIES) return cur;
        next[num] = slot;
      }
      return next;
    });
  }, []);

  const selKeyStr = JSON.stringify(sel);
  const tlas = snap?.drivers.map((d) => `${d.num}:${d.tla}`).join(",") ?? "";
  const series = useMemo<ChartSeries[]>(() => {
    const names = new Map(tlas.split(",").map((p) => p.split(":") as [string, string]));
    return Object.entries(sel ?? {})
      .sort((a, b) => a[1] - b[1])
      .map(([num, slot]) => ({ num, tla: names.get(num) ?? num, color: SERIES_COLORS[slot] }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selKeyStr, tlas]);
  const selectedColors = useMemo(() => Object.fromEntries(series.map((s) => [s.num, s.color])), [series]);

  // Recordar la posición del replay para retomar.
  const lastSaved = useRef(0);
  useEffect(() => {
    if (target.mode !== "replay" || !playback) return;
    if (Math.abs(performance.now() - lastSaved.current) < 2000) return;
    lastSaved.current = performance.now();
    store.set(`f1t:pos:${target.source}`, { time: Math.round(playback.time) });
  }, [target, playback]);

  // Eventos: la compuerta de spoilers decide qué se ve. La lista muestra lo ya ocurrido; las marcas de la barra,
  // con "Sin spoilers", llegan solo hasta el punto más lejano que ya se vio.
  const insights = t.insights;
  const filter = useEventFilter();
  const time = playback?.time ?? 0;
  const { highWater, reset: resetHighWater } = useHighWater(source, playback ? playback.time : null);
  const limit = spoilerFree ? Math.max(highWater, time) : Number.POSITIVE_INFINITY;
  const happened = useMemo(() => (insights ? visible(insights.events, time) : []), [insights, time]);
  const marked = useMemo(
    () => (insights ? visible(insights.events, limit).filter((e) => filter.set.has(e.kind)) : []),
    [insights, limit, filter.set],
  );
  const neutralMarks = useMemo(
    () => (insights && filter.set.has("neutralization") ? neutralAt(insights.neutral, limit) : []),
    [insights, limit, filter.set],
  );
  // Duelos activos y proyecciones, solo con lo que ya pasó. Se recalculan al cerrarse una vuelta, no en cada cuadro.
  const closedLaps = useMemo(() => (insights ? insights.laps.filter((l) => l.endTs <= time).length : 0), [insights, time]);
  const battles = useMemo(() => (insights ? activeBattles(insights.battles, time) : []), [insights, time]);
  const lapsLeft = snap?.lap ? snap.lap.total - snap.lap.current : null;
  const projected = useMemo(
    () =>
      insights?.isRace
        ? projections(
            insights.laps.filter((l) => l.endTs <= time),
            { ...PARAMS } as Params,
            lapsLeft,
          )
        : [],
    [insights, closedLaps, lapsLeft],
  );
  const jump = useCallback(
    (e: { seekTs: number }) => {
      send({ type: "seek", ts: jumpTarget(e as never) });
      send({ type: "play" });
    },
    [send],
  );

  // Atajos: espacio = play/pausa, flechas = ±5 s, J / K = evento anterior / siguiente.
  const pb = useRef(playback);
  pb.current = playback;
  const nav = useRef(marked);
  nav.current = marked;
  useEffect(() => {
    if (target.mode !== "replay") return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      const typing = ["INPUT", "SELECT", "TEXTAREA"].includes(el.tagName);
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      const p = pb.current;
      if (!p) return;
      const key = e.key.toLowerCase();
      if (key === "j" || key === "k") {
        const hit = neighbour(nav.current, p.time, key === "k" ? "next" : "prev");
        if (hit) jump(hit);
        e.preventDefault();
        return;
      }
      if (el.tagName === "BUTTON") return; // Espacio y flechas actúan sobre el botón enfocado
      if (e.code === "Space") send({ type: p.paused ? "play" : "pause" });
      else if (e.code === "ArrowLeft") send({ type: "seek", ts: p.time - 5000 });
      else if (e.code === "ArrowRight") send({ type: "seek", ts: p.time + 5000 });
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [target.mode, send, jump]);

  const circuit = useCircuit(snap?.session?.circuitKey, snap?.session?.year);
  const track = snap ? TRACK_STATUS[snap.track.status] : undefined;
  const w = snap?.weather;
  const noPositions =
    live?.status === "connected" && !live.topics["Position.z"]
      ? "El feed en vivo no está mandando posiciones (requiere cuenta de F1)."
      : null;

  const tower = snap && <Tower drivers={snap.drivers} through={snap.through} selected={selectedColors} onToggle={toggle} />;
  const map = snap && (
    <TrackMap
      outline={t.outline}
      circuit={circuit}
      snap={snap}
      tone={track?.tone}
      instant={(playback?.speed ?? 1) > 2}
      missingReason={noPositions}
    />
  );
  const raceState = snap && insights?.isRace && (
    <RaceState snap={snap} insights={insights} events={happened} battles={battles} projections={projected} />
  );
  const eventPanel = insights && (
    <EventPanel
      insights={insights}
      events={happened}
      filter={filter}
      startTs={insights.startTs}
      spoilerFree={spoilerFree}
      onJump={jump}
      onResetHighWater={() => resetHighWater(time)}
    />
  );
  const pace = insights?.isRace && <PacePanel insights={insights} now={time} selected={selectedColors} />;
  const ideal = insights && !insights.isRace && <IdealPanel insights={insights} now={time} />;
  const dominance = target.mode === "replay" && (
    <DominancePanel source={target.source} now={time} outline={t.outline} circuit={circuit} insights={insights} selected={selectedColors} />
  );
  const gapChart = snap && <GapChart history={t.history} version={t.histVersion} series={series} race={snap.lap !== null} />;
  const raceControl = snap && <RaceControl messages={snap.raceControl} count={snap.raceControl.length} />;
  const telemetry = snap && target.mode === "replay" && (
    <TelemetryPanel source={target.source} snap={snap} outline={t.outline} circuit={circuit} spoilerFree={spoilerFree} />
  );

  return (
    <div className="session">
      <header className="bar">
        <a href="#/" className="back">
          ← Sesiones
        </a>
        <div className="title">
          {snap?.session ? (
            <>
              {snap.session.meeting} <span className="muted">· {snap.session.name}</span>
            </>
          ) : (
            <span className="muted">{target.mode === "live" ? "En vivo" : "Replay"}</span>
          )}
        </div>
        <span className={`badge ${target.mode === "live" ? "badge-live" : ""}`}>{target.mode === "live" ? "LIVE" : "REPLAY"}</span>
        {snap && (
          <div className="facts">
            {snap.lap && (
              <span className="fact">
                Vuelta <strong>{snap.lap.current}</strong>/{snap.lap.total}
              </span>
            )}
            {snap.part ? (
              <span className="fact">
                <strong>Q{snap.part}</strong>
                {snap.status === "Started" && snap.remainingMs !== null
                  ? ` · quedan ${fmtDuration(snap.remainingMs)}`
                  : ` · ${SESSION_STATUS[snap.status] ?? snap.status}`}
              </span>
            ) : (
              snap.status && <span className="fact">{SESSION_STATUS[snap.status] ?? snap.status}</span>
            )}
            {track && (
              <span className="fact">
                <span className={`flag flag-${track.tone}`} />
                {track.label}
              </span>
            )}
            {snap.remainingMs !== null && !snap.lap && !snap.part && <span className="fact">Restan {fmtDuration(snap.remainingMs)}</span>}
            {w && (
              <span className="fact muted">
                Aire {w.air ?? "–"}° · Pista {w.track ?? "–"}°{w.rain ? " · Lluvia" : ""}
              </span>
            )}
          </div>
        )}
      </header>

      {target.mode === "replay" && playback && index && snap && (
        <Controls
          source={target.source}
          playback={playback}
          index={index}
          snap={snap}
          send={send}
          spoilerFree={spoilerFree}
          onSpoilerFree={setSpoilerFree}
          marks={
            insights
              ? {
                  events: marked,
                  neutral: neutralMarks,
                  limitTs: Number.isFinite(limit) ? limit : index.duration,
                  drivers: insights.drivers,
                  onJump: jump,
                }
              : undefined
          }
        />
      )}
      {insights && <DataQualityNote insights={insights} />}
      {live && <LivePanel live={live} now={snap?.time ?? Date.now()} />}

      {t.error && (
        <p className="notice notice-error">
          {t.error} <a href="#/">Volver a las sesiones</a>
        </p>
      )}
      {!t.error && t.loading && <p className="notice">Cargando: {t.loading}…</p>}
      {!t.connected && !t.loading && <p className="notice notice-error">Se cortó la conexión con el server local. Reintentando…</p>}

      {snap && (
        <>
          {phone ? (
            <>
              <div className="tabs" role="tablist" aria-label="Secciones">
                {TABS.filter((x) => !x.replayOnly || target.mode === "replay").map((x) => (
                  <button
                    key={x.id}
                    type="button"
                    role="tab"
                    id={`tab-${x.id}`}
                    aria-selected={shown === x.id}
                    aria-controls="tab-body"
                    className="tab"
                    onClick={() => setTab(x.id)}
                  >
                    {x.label}
                  </button>
                ))}
              </div>
              <div className="tab-body" id="tab-body" role="tabpanel" aria-labelledby={`tab-${shown}`}>
                {shown === "tower" && tower}
                {shown === "map" && (
                  <>
                    {map}
                    {raceState}
                  </>
                )}
                {shown === "gaps" && (
                  <>
                    {gapChart}
                    {pace}
                    {ideal}
                  </>
                )}
                {shown === "events" && (
                  <>
                    {eventPanel}
                    {raceControl}
                  </>
                )}
                {shown === "tel" && target.mode === "replay" && (
                  <>
                    {dominance}
                    {telemetry}
                  </>
                )}
              </div>
            </>
          ) : (
            <>
              <div className="grid">
                {tower}
                <aside>
                  {map}
                  {raceState}
                  {eventPanel}
                  {pace}
                  {ideal}
                  {dominance}
                  {gapChart}
                  {raceControl}
                </aside>
              </div>
              {telemetry && <div className="tel-wrap">{telemetry}</div>}
            </>
          )}
        </>
      )}
    </div>
  );
}
