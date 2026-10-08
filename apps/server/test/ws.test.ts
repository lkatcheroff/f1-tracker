import { buildIndex, buildInsights, findOutline, type LoadedSession, prepareMessages, type ServerMessage } from "@f1/core";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { sampleRace } from "../../../packages/core/test/builders";
import { buildApp } from "../src/app";

function synthetic(source: string): LoadedSession {
  const messages = prepareMessages(sampleRace().build());
  return {
    source,
    messages,
    index: buildIndex(messages),
    outline: findOutline(messages),
    origin: "official",
    insights: buildInsights(messages, { source: "official" }),
  };
}

/** Cliente de prueba: junta lo que llega y deja esperar por un mensaje concreto. */
class Client {
  readonly got: ServerMessage[] = [];
  private waiters: { pred: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void }[] = [];
  private constructor(readonly ws: WebSocket) {
    ws.on("message", (buf) => {
      const m = JSON.parse(buf.toString()) as ServerMessage;
      this.got.push(m);
      const hit = this.waiters.filter((w) => w.pred(m));
      this.waiters = this.waiters.filter((w) => !hit.includes(w));
      for (const w of hit) w.resolve(m);
    });
  }
  static async connect(url: string): Promise<Client> {
    const ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    return new Client(ws);
  }
  send(cmd: unknown) {
    this.ws.send(typeof cmd === "string" ? cmd : JSON.stringify(cmd));
  }
  /** Espera un mensaje nuevo (de acá en adelante) que cumpla la condición. */
  next<T extends ServerMessage["type"]>(type: T, pred: (m: Extract<ServerMessage, { type: T }>) => boolean = () => true, ms = 3000) {
    return new Promise<Extract<ServerMessage, { type: T }>>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`no llegó un mensaje "${type}" en ${ms} ms; llegaron: ${this.got.map((m) => m.type).join(",")}`)),
        ms,
      );
      this.waiters.push({
        pred: (m) => m.type === type && pred(m as never),
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m as never);
        },
      });
    });
  }
  close() {
    this.ws.close();
  }
}

let app: FastifyInstance;
let url: string;
let opened: string[];
let delays: Record<string, number>;
const clients: Client[] = [];
const connect = async () => {
  const c = await Client.connect(`${url}/ws`);
  clients.push(c);
  return c;
};

beforeAll(() => {
  // Pasa una vez por el import: el server no debe necesitar red ni disco para armarse.
  expect(buildApp).toBeTypeOf("function");
});

beforeEach(async () => {
  opened = [];
  delays = {};
  app = await buildApp({
    loadSession: async (source, onStep) => {
      opened.push(source);
      onStep("bajando");
      await new Promise((r) => setTimeout(r, delays[source] ?? 0));
      if (source === "rec:roto") throw new Error("la sesión no tiene datos");
      return synthetic(source);
    },
    loadTelemetryFile: async (source) => (source === "static:con-telemetria" ? new Uint8Array([1, 2, 3]) : null),
    listMeetings: async () => [],
    listRecordings: async () => [],
    liveHub: {
      join: (send) => {
        send({ type: "opened", mode: "live" });
        return { handle: () => {}, close: () => {} };
      },
    },
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  url = `ws://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await app.close();
});

describe("protocolo WebSocket de replay", () => {
  it("open: avisa los pasos de carga y abre con índice, trazado y análisis", async () => {
    const c = await connect();
    const loading = c.next("loading");
    const open = c.next("opened");
    c.send({ type: "open", mode: "replay", source: "static:a" });
    expect((await loading).step).toBe("bajando");
    const msg = await open;
    expect(msg).toMatchObject({ mode: "replay", source: "static:a" });
    if (msg.mode !== "replay") throw new Error("no es replay");
    expect(msg.index.duration).toBeGreaterThan(0);
    expect(msg.insights?.events.length).toBeGreaterThan(0);
  });

  it("después de abrir llegan snapshots con el estado del reproductor", async () => {
    const c = await connect();
    c.send({ type: "open", mode: "replay", source: "static:a" });
    const snap = await c.next("snapshot");
    expect(snap.playback).toMatchObject({ time: 0, speed: 1 });
    expect(snap.snap.drivers.length).toBe(5);
  });

  it("seek mueve el reloj; play y pause cambian el estado; speed solo acepta velocidades válidas", async () => {
    const c = await connect();
    c.send({ type: "open", mode: "replay", source: "static:a" });
    await c.next("snapshot");

    c.send({ type: "seek", ts: 150_000 });
    const sought = await c.next("snapshot", (m) => (m.playback?.time ?? 0) >= 150_000);
    expect(sought.playback?.time).toBeGreaterThanOrEqual(150_000);
    // Con la carrera avanzada ya hay vueltas completadas en la torre.
    expect(sought.snap.lap?.current).toBeGreaterThanOrEqual(2);

    c.send({ type: "pause" });
    expect((await c.next("snapshot", (m) => m.playback?.paused === true)).playback?.paused).toBe(true);

    c.send({ type: "speed", x: 4 });
    expect((await c.next("snapshot", (m) => m.playback?.speed === 4)).playback?.speed).toBe(4);
    c.send({ type: "speed", x: 3.7 }); // no es una velocidad del menú: se ignora
    c.send({ type: "play" });
    const playing = await c.next("snapshot", (m) => m.playback?.paused === false);
    expect(playing.playback?.speed).toBe(4);

    const t0 = playing.playback!.time;
    const later = await c.next("snapshot", (m) => (m.playback?.time ?? 0) > t0 + 500);
    expect(later.playback!.time).toBeGreaterThan(t0);
  });

  it("al llegar al final se detiene solo", async () => {
    const c = await connect();
    c.send({ type: "open", mode: "replay", source: "static:a" });
    const opened = await c.next("opened");
    if (opened.mode !== "replay") throw new Error("no es replay");
    c.send({ type: "seek", ts: opened.index.duration + 60_000 });
    c.send({ type: "play" });
    const end = await c.next("snapshot", (m) => m.playback?.time === opened.index.duration && m.playback.paused);
    expect(end.playback?.paused).toBe(true);
  });

  it("open con `at` arranca en esa posición", async () => {
    const c = await connect();
    c.send({ type: "open", mode: "replay", source: "static:a", at: 100_000 });
    const snap = await c.next("snapshot");
    expect(snap.playback?.time).toBeGreaterThanOrEqual(100_000);
  });

  it("un mensaje que no es JSON se ignora y la conexión sigue andando", async () => {
    const c = await connect();
    c.send("esto no es json");
    c.send({ type: "play" }); // sin sesión abierta: tampoco hace nada
    c.send({ type: "open", mode: "replay", source: "static:a" });
    expect((await c.next("opened")).mode).toBe("replay");
  });

  it("si la carga falla, manda un error legible", async () => {
    const c = await connect();
    c.send({ type: "open", mode: "replay", source: "rec:roto" });
    expect((await c.next("error")).message).toMatch(/no tiene datos/);
  });

  it("si se abre otra sesión mientras la primera carga, la primera no llega", async () => {
    delays["static:lenta"] = 300;
    const c = await connect();
    c.send({ type: "open", mode: "replay", source: "static:lenta" });
    c.send({ type: "open", mode: "replay", source: "static:rapida" });
    const msg = await c.next("opened");
    expect(msg.mode === "replay" && msg.source).toBe("static:rapida");
    await new Promise((r) => setTimeout(r, 500));
    const opens = c.got.filter((m) => m.type === "opened");
    expect(opens).toHaveLength(1);
    expect(opened).toEqual(["static:lenta", "static:rapida"]);
  });

  it("dos conexiones tienen cada una su propio reloj", async () => {
    const a = await connect();
    const b = await connect();
    a.send({ type: "open", mode: "replay", source: "static:a" });
    b.send({ type: "open", mode: "replay", source: "static:a" });
    await Promise.all([a.next("snapshot"), b.next("snapshot")]);
    a.send({ type: "seek", ts: 200_000 });
    await a.next("snapshot", (m) => (m.playback?.time ?? 0) >= 200_000);
    const fromB = await b.next("snapshot");
    expect(fromB.playback?.time).toBeLessThan(10_000);
  });

  it("modo live: se une al hub", async () => {
    const c = await connect();
    c.send({ type: "open", mode: "live" });
    expect((await c.next("opened")).mode).toBe("live");
  });
});

describe("API HTTP", () => {
  const http = (p: string) => app.inject({ method: "GET", url: p });

  it("/api/sessions devuelve el año pedido", async () => {
    const res = await http("/api/sessions?year=2025");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ year: 2025, meetings: [], recordings: [] });
  });

  it("/api/telemetry: 400 sin source, 404 sin telemetría, 200 con los bytes", async () => {
    expect((await http("/api/telemetry")).statusCode).toBe(400);
    expect((await http("/api/telemetry?source=static:nada")).statusCode).toBe(404);
    const ok = await http("/api/telemetry?source=static:con-telemetria");
    expect(ok.statusCode).toBe(200);
    expect([...ok.rawPayload]).toEqual([1, 2, 3]);
  });
});
