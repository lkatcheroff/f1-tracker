import {
  type ClientCommand,
  type ServerMessage,
  type SessionsResponse,
  type SessionTelemetry,
  TELEMETRY_VERSION,
  unpackTelemetry,
} from "@f1/core";

/**
 * El front habla el mismo protocolo en los dos despliegues:
 * - con server propio (desarrollo local, live): WebSocket;
 * - sitio estático (GitHub Pages): el replay corre en un Web Worker dentro del navegador.
 */
export const STATIC = import.meta.env.MODE === "pages";

const dataBase = () => new URL(`${import.meta.env.BASE_URL}data/`, location.href).href;

export type Target = { mode: "live" } | { mode: "replay"; source: string; at?: number };

export interface Transport {
  send(cmd: ClientCommand): void;
  close(): void;
}

interface Handlers {
  onMessage(m: ServerMessage): void;
  onConnected(connected: boolean): void;
  /** posición actual, para reabrir en el mismo punto tras una reconexión */
  resumeAt(): number | undefined;
}

const openCommand = (target: Target, at: number | undefined): ClientCommand =>
  target.mode === "live" ? { type: "open", mode: "live" } : { type: "open", mode: "replay", source: target.source, at };

function connectSocket(target: Target, h: Handlers): Transport {
  let ws: WebSocket | null = null;
  let closed = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  const open = () => {
    ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
    ws.onopen = () => {
      ws!.send(JSON.stringify(openCommand(target, h.resumeAt())));
      h.onConnected(true);
    };
    ws.onmessage = (ev) => h.onMessage(JSON.parse(ev.data));
    ws.onclose = () => {
      if (closed) return;
      h.onConnected(false);
      retry = setTimeout(open, 1500);
    };
  };
  open();
  return {
    send: (cmd) => ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify(cmd)),
    close: () => {
      closed = true;
      clearTimeout(retry);
      ws?.close();
    },
  };
}

function connectWorker(target: Target, h: Handlers): Transport {
  const worker = new Worker(new URL("./replay.worker.ts", import.meta.url), { type: "module" });
  worker.onmessage = (ev: MessageEvent<ServerMessage>) => h.onMessage(ev.data);
  worker.onerror = (ev) => h.onMessage({ type: "error", message: ev.message || "falló el reproductor" });
  worker.postMessage({ cmd: openCommand(target, h.resumeAt()), dataBase: dataBase() });
  h.onConnected(true);
  return {
    send: (cmd) => worker.postMessage({ cmd }),
    close: () => worker.terminate(),
  };
}

export const connect = (target: Target, h: Handlers): Transport => (STATIC ? connectWorker(target, h) : connectSocket(target, h));

/** Calendario del año. En el sitio estático sale de los archivos que publica la GitHub Action. */
export async function loadSessions(year: number): Promise<SessionsResponse> {
  const url = STATIC ? `${dataBase()}calendar-${year}.json` : `/api/sessions?year=${year}`;
  const res = await fetch(url, { cache: "no-cache" });
  if (!res.ok) throw new Error(STATIC ? `no hay calendario publicado para ${year}` : `el server respondió HTTP ${res.status}`);
  const body = await res.json();
  return STATIC ? { year, meetings: body, recordings: [] } : body;
}

/**
 * Telemetría de la sesión abierta, o null si no hay. Se pide recién cuando el usuario abre el panel:
 * pesa 1 a 2 MB. En el sitio estático la publica la Action junto con cada sesión; en local la arma el server.
 */
export async function loadTelemetry(source: string): Promise<SessionTelemetry | null> {
  let url: string;
  if (STATIC) {
    const key = /^mirror:s\/(\d+)\./.exec(source)?.[1];
    if (!key) return null; // sesiones cargadas desde OpenF1 en el navegador: sin telemetría
    url = `${dataBase()}t/${key}.v${TELEMETRY_VERSION}.json.gz`;
  } else {
    url = `/api/telemetry?source=${encodeURIComponent(source)}`;
  }
  const res = await fetch(url, { cache: "no-cache" });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`no se pudo bajar la telemetría (HTTP ${res.status})`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  return bytes.length ? unpackTelemetry(bytes) : null; // vacío = la Action no pudo armarla para esta sesión
}
