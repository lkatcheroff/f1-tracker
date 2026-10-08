import type { DataSource, LiveState, RawMessage } from "@f1/core";
import WebSocket from "ws";
import { config } from "./config";

const RS = "\x1e";

export const LIVE_TOPICS = [
  "Heartbeat",
  "DriverList",
  "ExtrapolatedClock",
  "RaceControlMessages",
  "SessionInfo",
  "SessionStatus",
  "SessionData",
  "TeamRadio",
  "TimingAppData",
  "TimingData",
  "TimingStats",
  "TrackStatus",
  "WeatherData",
  "Position.z",
  "CarData.z",
  "TopThree",
  "LapCount",
];

/**
 * Cliente mínimo de SignalR Core (protocolo JSON) contra el feed de live timing, sin autenticación.
 * Verificado el 2026-10-02 con la sesión terminada: negocia, acepta `Subscribe` y devuelve el estado
 * inicial de cada topic, salvo `Position.z` y `CarData.z`. Ver docs/spikes.md.
 */
export class LiveSource implements DataSource {
  readonly state: LiveState = { status: "connecting", detail: "", subscribed: LIVE_TOPICS, initial: [], topics: {}, recording: null };
  private queue: RawMessage[] = [];
  private wake: (() => void) | null = null;
  private ws: WebSocket | null = null;
  private ping: NodeJS.Timeout | null = null;
  private retry: NodeJS.Timeout | null = null;
  private attempts = 0;
  private stopped = false;

  async *start(): AsyncIterable<RawMessage> {
    void this.connect();
    while (!this.stopped) {
      while (this.queue.length) yield this.queue.shift()!;
      await new Promise<void>((r) => (this.wake = r));
    }
  }

  stop(): void {
    this.stopped = true;
    this.state.status = "closed";
    if (this.ping) clearInterval(this.ping);
    if (this.retry) clearTimeout(this.retry);
    this.ws?.close();
    this.wake?.();
  }

  private push(topic: string, data: unknown): void {
    const ts = Date.now();
    let h = this.state.topics[topic];
    if (!h) {
      h = { count: 0, lastTs: 0 };
      this.state.topics[topic] = h;
    }
    h.count++;
    h.lastTs = ts;
    this.queue.push({ topic, data, ts });
    this.wake?.();
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    this.state.status = this.attempts ? "reconnecting" : "connecting";
    try {
      const neg = await fetch(`https://${config.liveBase}/negotiate?negotiateVersion=1`, {
        method: "POST",
        signal: AbortSignal.timeout(15_000),
      });
      if (!neg.ok) throw new Error(`negotiate respondió HTTP ${neg.status}`);
      // El balanceador de F1 fija el backend por cookie: sin ella el WebSocket cae en otro nodo y falla.
      const cookie = neg.headers
        .getSetCookie()
        .map((c) => c.split(";")[0])
        .join("; ");
      const { connectionToken } = (await neg.json()) as { connectionToken: string };
      const ws = new WebSocket(`wss://${config.liveBase}?id=${encodeURIComponent(connectionToken)}`, {
        headers: { Cookie: cookie },
      });
      this.ws = ws;
      let handshaken = false;

      ws.on("open", () => ws.send(JSON.stringify({ protocol: "json", version: 1 }) + RS));
      ws.on("message", (buf) => {
        for (const part of buf.toString().split(RS)) {
          if (!part) continue;
          const m = JSON.parse(part);
          if (!handshaken) {
            if (m.error) {
              this.fail(`handshake: ${m.error}`);
              return;
            }
            handshaken = true;
            ws.send(JSON.stringify({ type: 1, invocationId: "sub", target: "Subscribe", arguments: [LIVE_TOPICS] }) + RS);
            continue;
          }
          this.onRecord(m);
        }
      });
      ws.on("close", (code) => this.fail(`conexión cerrada (${code})`));
      ws.on("error", (err) => this.fail(err.message));
      this.ping = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: 6 }) + RS), 15_000);
    } catch (err) {
      this.fail(err instanceof Error ? err.message : String(err));
    }
  }

  private onRecord(m: any): void {
    if (m.type === 3 && m.invocationId === "sub") {
      if (m.error) {
        this.fail(`Subscribe: ${m.error}`);
        return;
      }
      const result = (m.result ?? {}) as Record<string, unknown>;
      this.state.initial = LIVE_TOPICS.filter((t) => result[t] !== undefined);
      this.state.status = "connected";
      this.state.detail = "";
      this.attempts = 0;
      // SessionInfo primero: el resto del pipeline lo usa para saber de qué sesión son los datos.
      const order = ["SessionInfo", ...this.state.initial.filter((t) => t !== "SessionInfo")];
      for (const t of order) if (result[t] !== undefined) this.push(t, result[t]);
    } else if (m.type === 1 && m.target === "feed") {
      // UNVERIFIED: forma de los mensajes incrementales, `arguments: [topic, data, timestamp]`.
      // No se pudo observar sin una sesión en curso; es la que documentan FastF1 y f1-dash.
      const [topic, data] = m.arguments ?? [];
      if (typeof topic === "string") this.push(topic, data);
    } else if (m.type === 7) {
      this.fail(`el servidor cerró la conexión${m.error ? `: ${m.error}` : ""}`);
    }
  }

  private fail(detail: string): void {
    if (this.stopped || this.retry) return;
    if (this.ping) clearInterval(this.ping);
    this.ws?.removeAllListeners();
    this.ws?.on("error", () => {});
    this.ws?.close();
    this.ws = null;
    this.state.status = "reconnecting";
    this.state.detail = detail;
    const delay = [2000, 5000, 10_000, 30_000][Math.min(this.attempts++, 3)];
    this.retry = setTimeout(() => {
      this.retry = null;
      void this.connect();
    }, delay);
  }
}
