/// <reference lib="webworker" />
import {
  buildIndex,
  buildInsights,
  type ClientCommand,
  findOutline,
  type LoadedSession,
  prepareMessages,
  ReplayPlayer,
  type ServerMessage,
  unpackSession,
} from "@f1/core";
import { loadOpenF1Session } from "@f1/openf1";

// Reproductor del sitio estático: hace en el navegador lo que en local hace el server.

const SNAPSHOT_MS = 250;
const post = (m: ServerMessage) => postMessage(m);

let player: ReplayPlayer | null = null;
let opening = 0;

async function load(source: string, dataBase: string, onStep: (s: string) => void): Promise<LoadedSession> {
  const sep = source.indexOf(":");
  const kind = source.slice(0, sep);
  const ref = source.slice(sep + 1);
  if (kind === "mirror") {
    if (!/^s\/\d+\.v\d+\.json\.gz$/.test(ref)) throw new Error(`archivo de sesión inválido: ${ref}`);
    onStep("bajando la sesión");
    const res = await fetch(dataBase + ref);
    if (!res.ok) throw new Error(`no se pudo bajar la sesión (HTTP ${res.status})`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    onStep("procesando");
    const session = unpackSession(bytes, source);
    onStep("analizando la sesión");
    return { ...session, insights: buildInsights(session.messages, { source: session.origin ?? "openf1" }) };
  }
  if (kind === "openf1") {
    const messages = prepareMessages(await loadOpenF1Session(ref, onStep));
    onStep("analizando la sesión");
    return {
      source,
      messages,
      index: buildIndex(messages),
      outline: findOutline(messages),
      origin: "openf1",
      insights: buildInsights(messages, { source: "openf1" }),
    };
  }
  throw new Error("esta fuente necesita el server local");
}

setInterval(() => {
  if (player) for (const m of player.frame(Date.now())) post(m);
}, SNAPSHOT_MS);

self.onmessage = async (ev: MessageEvent<{ cmd: ClientCommand; dataBase?: string }>) => {
  const { cmd, dataBase } = ev.data;
  if (cmd.type !== "open") return player?.handle(cmd, Date.now());
  player = null;
  const mine = ++opening;
  if (cmd.mode !== "replay") return post({ type: "error", message: "El modo live necesita el server local." });
  try {
    const session = await load(cmd.source, dataBase ?? "", (step) => mine === opening && post({ type: "loading", step }));
    if (mine !== opening) return;
    player = new ReplayPlayer(session, Date.now(), cmd.at);
    post(player.opened());
  } catch (err) {
    if (mine === opening) post({ type: "error", message: err instanceof Error ? err.message : String(err) });
  }
};
