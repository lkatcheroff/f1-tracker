import {
  buildIndex,
  buildInsights,
  buildTelemetry,
  type DataSourceKind,
  findOutline,
  type LoadedSession,
  packTelemetry,
  prepareMessages,
  type RawMessage,
} from "@f1/core";
import { loadStaticSession } from "./archive";
import { loadOpenF1Session } from "./openf1";
import { loadRecording } from "./recorder";

const ORIGIN: Record<string, DataSourceKind> = { static: "official", openf1: "openf1", rec: "recording" };

const cache = new Map<string, Promise<LoadedSession>>();
const MAX_CACHED = 2;

async function loadRaw(source: string, onStep: (s: string) => void): Promise<RawMessage[]> {
  const sep = source.indexOf(":");
  const kind = source.slice(0, sep);
  const ref = source.slice(sep + 1);
  if (kind === "static") {
    const raw = await loadStaticSession(ref, onStep);
    if (!raw) throw new Error("F1 todavía no publicó esta sesión en el archivo estático. Probá con OpenF1.");
    return raw;
  }
  if (kind === "rec") return loadRecording(ref);
  if (kind === "openf1") return loadOpenF1Session(ref, onStep);
  throw new Error(`fuente desconocida: ${source}`);
}

/** Carga una sesión para replay. Las últimas quedan en memoria para reabrir sin reprocesar. */
export function loadSession(source: string, onStep: (s: string) => void): Promise<LoadedSession> {
  const hit = cache.get(source);
  if (hit) return hit;
  const p = (async () => {
    const messages = prepareMessages(await loadRaw(source, onStep));
    if (!messages.length) throw new Error("la sesión no tiene datos");
    onStep("indexando");
    const origin = ORIGIN[source.slice(0, source.indexOf(":"))] ?? "official";
    onStep("analizando la sesión");
    return {
      source,
      messages,
      index: buildIndex(messages),
      outline: findOutline(messages),
      origin,
      insights: buildInsights(messages, { source: origin }),
    };
  })();
  cache.set(source, p);
  p.catch(() => cache.delete(source));
  while (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value!);
  return p;
}

const telemetryCache = new Map<string, Promise<Uint8Array | null>>();

/** Telemetría de una sesión, ya empaquetada (el mismo formato que publica el sitio). null si no se pudo armar. */
export function loadTelemetryFile(source: string): Promise<Uint8Array | null> {
  const hit = telemetryCache.get(source);
  if (hit) return hit;
  const p = (async () => {
    const session = await loadSession(source, () => {});
    const tel = buildTelemetry(session.messages, session.outline);
    return tel ? packTelemetry(tel) : null;
  })();
  telemetryCache.set(source, p);
  p.catch(() => telemetryCache.delete(source));
  while (telemetryCache.size > MAX_CACHED) telemetryCache.delete(telemetryCache.keys().next().value!);
  return p;
}
