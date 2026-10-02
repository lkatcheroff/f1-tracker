import { buildIndex, findOutline, prepareMessages, type LoadedSession, type RawMessage } from "@f1/core";
import { loadStaticSession } from "./archive";
import { loadOpenF1Session } from "./openf1";
import { loadRecording } from "./recorder";

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
    return { source, messages, index: buildIndex(messages), outline: findOutline(messages) };
  })();
  cache.set(source, p);
  p.catch(() => cache.delete(source));
  while (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value!);
  return p;
}
