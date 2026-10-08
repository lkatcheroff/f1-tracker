import { type ClientCommand, type LoadedSession, ReplayPlayer, type ServerMessage, StateEngine, type TrackOutline } from "@f1/core";
import { LiveSource } from "./liveSource";
import { Recorder } from "./recorder";

export type Send = (m: ServerMessage) => void;

const SNAPSHOT_MS = 250;

export interface ClientSession {
  handle(cmd: ClientCommand): void;
  close(): void;
}

/** Un replay por conexión: su propio reproductor, reloj y posición. */
export class ReplaySession implements ClientSession {
  private readonly player: ReplayPlayer;
  private readonly timer: NodeJS.Timeout;

  constructor(
    loaded: LoadedSession,
    private readonly send: Send,
    at?: number,
  ) {
    this.player = new ReplayPlayer(loaded, Date.now(), at);
    send(this.player.opened());
    this.timer = setInterval(() => this.tick(), SNAPSHOT_MS);
  }

  handle(cmd: ClientCommand): void {
    this.player.handle(cmd, Date.now());
  }

  private tick(): void {
    for (const m of this.player.frame(Date.now())) this.send(m);
  }

  close(): void {
    clearInterval(this.timer);
  }
}

interface LiveClient {
  send: Send;
  sentHist: number;
  sentOutline: TrackOutline | null;
}

/**
 * Una sola conexión al feed de F1 compartida por todos los clientes live.
 * Graba lo que entra y se desconecta cuando no queda nadie mirando.
 */
class LiveHub {
  private clients = new Set<LiveClient>();
  private engine = new StateEngine({ epochTs: true });
  private source: LiveSource | null = null;
  private recorder = new Recorder();
  private timer: NodeJS.Timeout | null = null;
  private idle: NodeJS.Timeout | null = null;
  private sessionPath = "";

  join(send: Send): ClientSession {
    const client: LiveClient = { send, sentHist: 0, sentOutline: null };
    this.clients.add(client);
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
    send({ type: "opened", mode: "live" });
    if (!this.source) this.startSource();
    return {
      handle: () => {},
      close: () => {
        this.clients.delete(client);
        if (!this.clients.size) this.idle = setTimeout(() => this.stopSource(), 30_000);
      },
    };
  }

  private startSource(): void {
    const source = new LiveSource();
    this.source = source;
    this.engine = new StateEngine({ epochTs: true });
    this.sessionPath = "";
    this.timer = setInterval(() => this.tick(), SNAPSHOT_MS);
    void (async () => {
      for await (const msg of source.start()) {
        this.recorder.write(msg);
        if (msg.topic === "SessionInfo") this.onSessionInfo(msg.data);
        this.engine.apply(msg);
      }
    })();
  }

  /** Si empieza otra sesión con el server conectado, el estado arranca de cero. */
  private onSessionInfo(data: unknown): void {
    const p = (data as { Path?: string })?.Path;
    if (typeof p !== "string" || p === this.sessionPath) return;
    if (this.sessionPath) {
      this.engine = new StateEngine({ epochTs: true });
      for (const c of this.clients) c.sentOutline = null;
    }
    this.sessionPath = p;
  }

  private stopSource(): void {
    if (this.timer) clearInterval(this.timer);
    this.source?.stop();
    this.source = null;
    this.recorder.close();
  }

  private tick(): void {
    if (!this.source) return;
    const live = { ...this.source.state, recording: this.recorder.file };
    const snap = this.engine.snapshot(Date.now());
    const hist = this.engine.history;
    for (const c of this.clients) {
      c.send({ type: "snapshot", snap, live });
      // Se reenvía si cambió: el trazado llega primero y la calle de boxes, con la primera parada.
      if (this.engine.outline && c.sentOutline !== this.engine.outline) {
        c.send({ type: "outline", outline: this.engine.outline });
        c.sentOutline = this.engine.outline;
      }
      if (hist.length < c.sentHist) c.send({ type: "history", reset: true, points: hist });
      else if (hist.length > c.sentHist) c.send({ type: "history", reset: false, points: hist.slice(c.sentHist) });
      c.sentHist = hist.length;
    }
  }
}

export const liveHub = new LiveHub();
