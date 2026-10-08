import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useCircuit } from "./circuit";
import { Controls } from "./Controls";
import { fmtDuration, SESSION_STATUS, store, TRACK_STATUS } from "./format";
import { GapChart, SERIES_COLORS, type ChartSeries } from "./GapChart";
import { LivePanel } from "./LivePanel";
import { RaceControl } from "./RaceControl";
import { TelemetryPanel } from "./TelemetryPanel";
import { Tower } from "./Tower";
import { TrackMap } from "./TrackMap";
import type { Target } from "./transport";
import { useTracker } from "./useTracker";

const MAX_SERIES = SERIES_COLORS.length;

export function SessionView({ target }: { target: Target }) {
  const t = useTracker(target);
  const { snap, playback, live, index, send } = t;
  const source = target.mode === "replay" ? target.source : "live";

  const [spoilerFree, setSpoilerFree] = useState(() => store.get("f1t:spoilerFree", true));
  useEffect(() => store.set("f1t:spoilerFree", spoilerFree), [spoilerFree]);

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

  // Atajos: espacio = play/pausa, flechas = ±5 s.
  const pb = useRef(playback);
  pb.current = playback;
  useEffect(() => {
    if (target.mode !== "replay") return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (["INPUT", "SELECT", "TEXTAREA", "BUTTON"].includes(el.tagName) || e.metaKey || e.ctrlKey || e.altKey) return;
      const p = pb.current;
      if (!p) return;
      if (e.code === "Space") send({ type: p.paused ? "play" : "pause" });
      else if (e.code === "ArrowLeft") send({ type: "seek", ts: p.time - 5000 });
      else if (e.code === "ArrowRight") send({ type: "seek", ts: p.time + 5000 });
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [target.mode, send]);

  const circuit = useCircuit(snap?.session?.circuitKey, snap?.session?.year);
  const track = snap ? TRACK_STATUS[snap.track.status] : undefined;
  const w = snap?.weather;
  const noPositions =
    live?.status === "connected" && !live.topics["Position.z"]
      ? "El feed en vivo no está mandando posiciones (requiere cuenta de F1)."
      : null;

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
        />
      )}
      {live && <LivePanel live={live} now={snap?.time ?? Date.now()} />}

      {t.error && (
        <p className="notice notice-error">
          {t.error} <a href="#/">Volver a las sesiones</a>
        </p>
      )}
      {!t.error && t.loading && <p className="notice">Cargando: {t.loading}…</p>}
      {!t.connected && !t.loading && <p className="notice notice-error">Se cortó la conexión con el server local. Reintentando…</p>}

      {snap && (
        <div className="grid">
          <Tower drivers={snap.drivers} through={snap.through} selected={selectedColors} onToggle={toggle} />
          <aside>
            <TrackMap
              outline={t.outline}
              circuit={circuit}
              snap={snap}
              tone={track?.tone}
              instant={(playback?.speed ?? 1) > 2}
              missingReason={noPositions}
            />
            <GapChart history={t.history} version={t.histVersion} series={series} race={snap.lap !== null} />
            <RaceControl messages={snap.raceControl} count={snap.raceControl.length} />
          </aside>
        </div>
      )}
      {snap && target.mode === "replay" && (
        <div className="tel-wrap">
          <TelemetryPanel source={target.source} snap={snap} outline={t.outline} circuit={circuit} spoilerFree={spoilerFree} />
        </div>
      )}
    </div>
  );
}
