import { StateEngine } from "./engine";
import type { RawMessage, SessionIndex, TrackOutline } from "./types";

/** Reloj de reproducción: `sessionTime = anchor + (now - wallAnchor) * speed`. Recibe `now` de afuera. */
export class PlaybackClock {
  speed = 1;
  paused = true;
  private anchor = 0;
  private wallAnchor = 0;

  now(wall: number): number {
    return this.paused ? this.anchor : this.anchor + (wall - this.wallAnchor) * this.speed;
  }
  seek(ts: number, wall: number): void {
    this.anchor = Math.max(0, ts);
    this.wallAnchor = wall;
  }
  setSpeed(x: number, wall: number): void {
    this.seek(this.now(wall), wall);
    this.speed = x;
  }
  pause(wall: number): void {
    this.seek(this.now(wall), wall);
    this.paused = true;
  }
  resume(wall: number): void {
    this.wallAnchor = wall;
    this.paused = false;
  }
}

/** Índice de navegación de una sesión ya preparada (mensajes normalizados y ordenados). */
export function buildIndex(messages: RawMessage[]): SessionIndex {
  const index: SessionIndex = {
    duration: messages.length ? messages[messages.length - 1].ts : 0,
    starts: [],
    totalLaps: null,
    laps: [],
    events: [],
  };
  let status = "";
  for (const m of messages) {
    const d = m.data as Record<string, any>;
    if (m.topic === "SessionStatus" && d?.Status && d.Status !== status) {
      status = d.Status;
      if (status === "Started") index.starts.push(m.ts);
      index.events.push({ ts: m.ts, kind: "session", value: status });
    } else if (m.topic === "TrackStatus" && d?.Message) {
      index.events.push({ ts: m.ts, kind: "track", value: d.Message });
    } else if (m.topic === "LapCount") {
      if (typeof d?.TotalLaps === "number") index.totalLaps = d.TotalLaps;
      if (typeof d?.CurrentLap === "number") index.laps.push({ lap: d.CurrentLap, ts: m.ts });
    }
  }
  // La vuelta 1 se anuncia mucho antes de la largada: "ir a vuelta 1" es ir a la largada.
  const first = index.laps[0];
  if (first?.lap === 1 && index.starts.length && index.starts[0] > first.ts) first.ts = index.starts[0];
  return index;
}

/**
 * Recorre la sesión hasta tener el trazado (primera vuelta limpia) y la calle de boxes (primera parada).
 * Si nadie para en toda la sesión, devuelve el trazado solo.
 */
export function findOutline(messages: RawMessage[]): TrackOutline | null {
  const engine = new StateEngine({ gapSampleEvery: Infinity });
  for (const m of messages) {
    if (m.topic !== "Position" && m.topic !== "TimingData") continue;
    engine.apply(m);
    if (engine.outline?.pit) break;
  }
  return engine.outline;
}
