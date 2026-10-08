import { StateEngine } from "./engine";
import type { ClientCommand, ServerMessage } from "./protocol";
import { PlaybackClock } from "./replay";
import type { RawMessage, SessionIndex, TrackOutline } from "./types";

/** Sesión lista para reproducir: mensajes normalizados y ordenados + índice de navegación. */
export interface LoadedSession {
  source: string;
  messages: RawMessage[];
  index: SessionIndex;
  outline: TrackOutline | null;
}

export const SPEEDS = [0.5, 1, 2, 4, 8, 16];

/**
 * Reproductor de una sesión grabada: reloj + engine + posición en la lista de mensajes.
 * No usa timers ni mira la hora: quien lo hospeda (el server o un Web Worker) le pasa `wall`
 * (ms de reloj de pared) y llama a `frame` periódicamente.
 */
export class ReplayPlayer {
  readonly clock = new PlaybackClock();
  private readonly engine = new StateEngine({ checkpointEvery: 30_000 });
  private sentHist = 0;

  constructor(
    private readonly session: LoadedSession,
    wall: number,
    at?: number,
  ) {
    this.engine.outline = session.outline;
    // Sin posición guardada, arranca dos minutos antes de la largada (antes de eso casi no hay datos).
    const first = session.index.starts[0];
    this.seek(at ?? (first ? first - 120_000 : 0), wall);
  }

  opened(): ServerMessage {
    const { source, index, outline } = this.session;
    return { type: "opened", mode: "replay", source, index, outline };
  }

  handle(cmd: ClientCommand, wall: number): void {
    switch (cmd.type) {
      case "play":
        if (this.clock.now(wall) < this.session.index.duration) this.clock.resume(wall);
        return;
      case "pause":
        this.clock.pause(wall);
        return;
      case "speed":
        if (SPEEDS.includes(cmd.x)) this.clock.setSpeed(cmd.x, wall);
        return;
      case "seek":
        if (Number.isFinite(cmd.ts)) this.seek(cmd.ts, wall);
        return;
    }
  }

  private seek(ts: number, wall: number): void {
    const target = Math.min(Math.max(0, ts), this.session.index.duration);
    // Hacia atrás: el engine vuelve a un checkpoint y se re-aplican los mensajes desde ahí.
    if (target < this.engine.time) this.engine.rewindTo(target);
    this.clock.seek(target, wall);
  }

  /** Aplica los mensajes vencidos según el reloj y devuelve lo que hay que mandar al front. */
  frame(wall: number): ServerMessage[] {
    const { messages, index } = this.session;
    let time = this.clock.now(wall);
    if (time >= index.duration) {
      time = index.duration;
      this.clock.seek(time, wall);
      this.clock.pause(wall);
    }
    // `engine.seq` es la cantidad de mensajes aplicados: sirve de cursor sobre la lista.
    while (this.engine.seq < messages.length && messages[this.engine.seq].ts <= time) this.engine.apply(messages[this.engine.seq]);

    const out: ServerMessage[] = [
      { type: "snapshot", snap: this.engine.snapshot(time), playback: { time, paused: this.clock.paused, speed: this.clock.speed } },
    ];
    const hist = this.engine.history;
    if (hist.length < this.sentHist) out.push({ type: "history", reset: true, points: hist.slice() });
    else if (hist.length > this.sentHist) out.push({ type: "history", reset: false, points: hist.slice(this.sentHist) });
    this.sentHist = hist.length;
    return out;
  }
}
