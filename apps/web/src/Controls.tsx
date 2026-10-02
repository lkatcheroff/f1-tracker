import type { ClientCommand, PlaybackState, SessionIndex, Snapshot } from "@f1/core";
import { useEffect, useState } from "react";
import { fmtDuration, store } from "./format";

const SPEEDS = [0.5, 1, 2, 4, 8, 16];

interface Props {
  source: string;
  playback: PlaybackState;
  index: SessionIndex;
  snap: Snapshot;
  send: (cmd: ClientCommand) => void;
  spoilerFree: boolean;
  onSpoilerFree: (v: boolean) => void;
}

export function Controls({ source, playback, index, snap, send, spoilerFree, onSpoilerFree }: Props) {
  const offsetKey = `f1t:offset:${source}`;
  /** segundos que el tracker va corrido respecto del video después de sincronizar */
  const [offset, setOffset] = useState(() => store.get(offsetKey, 0));
  const [drag, setDrag] = useState<number | null>(null);
  useEffect(() => store.set(offsetKey, offset), [offsetKey, offset]);

  const { time, paused, speed } = playback;
  const seek = (ts: number) => send({ type: "seek", ts });

  // Largada más cercana al punto actual (en clasificación hay una por parte).
  const start = index.starts.length
    ? index.starts.reduce((best, s) => (Math.abs(s - time) < Math.abs(best - time) ? s : best))
    : null;
  const sinceStart = index.starts.length ? time - index.starts[0] : null;

  const sync = () => {
    if (start === null) return;
    seek(start + offset * 1000);
    send({ type: "play" });
  };
  /** Ajuste fino: mueve el tracker respecto del video y recuerda el corrimiento. */
  const nudge = (d: number) => {
    seek(time + d * 1000);
    setOffset((o) => Math.round((o + d) * 10) / 10);
  };
  const editOffset = (v: number) => {
    if (!Number.isFinite(v)) return;
    seek(time + (v - offset) * 1000);
    setOffset(v);
  };

  const hasLaps = index.laps.length > 1 && !!index.totalLaps;
  const goLap = (n: number) => {
    const hit = [...index.laps].reverse().find((l) => l.lap <= n);
    if (hit) seek(hit.ts);
  };
  // Sin spoilers, la barra va por vuelta: la duración total delataría banderas rojas y demoras.
  const byLap = hasLaps && spoilerFree;
  const sliderMax = byLap ? index.totalLaps! : index.duration;
  const sliderNow = byLap ? (snap.lap?.current ?? 1) : time;
  const commit = () => {
    if (drag === null) return;
    if (byLap) goLap(drag);
    else seek(drag);
    setDrag(null);
  };

  return (
    <section className="controls" aria-label="Controles de reproducción">
      <div className="ctl-row">
        <button className="btn btn-icon" onClick={() => send({ type: paused ? "play" : "pause" })} title="Reproducir o pausar (Espacio)">
          {paused ? "▶ Reproducir" : "❚❚ Pausar"}
        </button>
        <button className="btn" onClick={() => seek(time - 5000)} title="Retroceder 5 segundos (flecha izquierda)">
          −5 s
        </button>
        <button className="btn" onClick={() => seek(time + 5000)} title="Avanzar 5 segundos (flecha derecha)">
          +5 s
        </button>
        <label className="field">
          Velocidad
          <select value={speed} onChange={(e) => send({ type: "speed", x: Number(e.target.value) })}>
            {SPEEDS.map((x) => (
              <option key={x} value={x}>
                {x}×
              </option>
            ))}
          </select>
        </label>
        {hasLaps && (
          <label className="field">
            Ir a vuelta
            <select value={snap.lap?.current ?? 1} onChange={(e) => goLap(Number(e.target.value))}>
              {Array.from({ length: index.totalLaps! }, (_, i) => i + 1).map((n) => (
                <option key={n}>{n}</option>
              ))}
            </select>
          </label>
        )}
        <span className="clock">
          {sinceStart === null
            ? fmtDuration(time)
            : sinceStart >= 0
              ? `${fmtDuration(sinceStart)} desde la largada`
              : `${fmtDuration(-sinceStart)} para la largada`}
          {!spoilerFree && <span className="muted"> · {fmtDuration(time)} de {fmtDuration(index.duration)}</span>}
        </span>
        <label className="check">
          <input type="checkbox" checked={spoilerFree} onChange={(e) => onSpoilerFree(e.target.checked)} />
          Sin spoilers
        </label>
      </div>

      <div className="ctl-row">
        <button
          className="btn btn-primary"
          onClick={sync}
          disabled={start === null}
          title="Sync: largada. Apretalo cuando se apagan los semáforos en el video"
        >
          Sync: largada
        </button>
        <span className="field">
          Ajuste fino
          <span className="btn-group">
            {[-5, -1, 1, 5].map((d) => (
              <button key={d} className="btn" onClick={() => nudge(d)}>
                {d > 0 ? `+${d}` : `−${-d}`} s
              </button>
            ))}
          </span>
        </span>
        <label className="field" title="Segundos que el tracker va adelantado (+) o atrasado (−) respecto del video. Se recuerda por sesión.">
          Offset
          <input type="number" step="0.5" value={offset} onChange={(e) => editOffset(e.target.valueAsNumber)} />s
        </label>
        <input
          className="scrub"
          type="range"
          min={byLap ? 1 : 0}
          max={sliderMax}
          step={byLap ? 1 : 1000}
          value={drag ?? sliderNow}
          onChange={(e) => setDrag(Number(e.target.value))}
          onPointerUp={commit}
          onKeyUp={commit}
          onBlur={commit}
          aria-label={byLap ? "Vuelta" : "Posición en la sesión"}
        />
        {drag !== null && <span className="muted small">{byLap ? `vuelta ${drag}` : fmtDuration(drag)}</span>}
      </div>
    </section>
  );
}
