import { gunzipSync, gzipSync, strFromU8, strToU8 } from "fflate";
import type { LoadedSession } from "./player";
import type { RawMessage } from "./types";

/** Streams del archivo estático de F1 que usa el replay. `CarData.z` y `TimingStats` quedan fuera del MVP. */
export const REPLAY_TOPICS = [
  "SessionInfo", "Heartbeat", "DriverList", "TimingData", "TimingAppData", "LapCount", "SessionStatus",
  "TrackStatus", "RaceControlMessages", "WeatherData", "ExtrapolatedClock", "Position.z",
];

/** Versión del formato. Va también en el nombre del archivo: al subirla, las sesiones publicadas se regeneran. */
export const PACK_VERSION = 2;
const VERSION = PACK_VERSION;

/**
 * Empaqueta una sesión ya preparada en un único archivo gzip, para publicarla como archivo estático.
 * Las posiciones van en forma compacta (`[x, y, enPista]` por auto), que el engine también entiende.
 */
export function packSession(session: Omit<LoadedSession, "source">): Uint8Array {
  const topics: string[] = [];
  const messages = session.messages.map((m) => {
    let t = topics.indexOf(m.topic);
    if (t === -1) t = topics.push(m.topic) - 1;
    let data = m.data;
    if (m.topic === "Position") {
      const compact: Record<string, [number, number, number]> = {};
      for (const [num, e] of Object.entries(data as Record<string, any>)) {
        compact[num] = Array.isArray(e) ? (e as [number, number, number]) : [e.X, e.Y, e.Status === "OnTrack" ? 1 : 0];
      }
      data = compact;
    }
    return [t, m.ts, data];
  });
  return gzipSync(strToU8(JSON.stringify({ v: VERSION, topics, messages, index: session.index, outline: session.outline })), { level: 9 });
}

export function unpackSession(bytes: Uint8Array, source: string): LoadedSession {
  const d = JSON.parse(strFromU8(gunzipSync(bytes)));
  if (d.v !== VERSION) throw new Error(`formato de sesión desconocido (v${d.v})`);
  const messages: RawMessage[] = d.messages.map(([t, ts, data]: [number, number, unknown]) => ({ topic: d.topics[t], ts, data }));
  return { source, messages, index: d.index, outline: d.outline };
}
