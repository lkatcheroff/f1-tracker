import { inflateSync, strFromU8 } from "fflate";
import type { RawMessage } from "./types";

const TS_RE = /^(\d+):(\d{2}):(\d{2})\.(\d{3})/;

/** "HH:MM:SS.mmm" → ms */
export function parseStreamTs(s: string): number {
  const m = TS_RE.exec(s);
  if (!m) throw new Error(`timestamp inválido: ${s.slice(0, 16)}`);
  return ((+m[1] * 60 + +m[2]) * 60 + +m[3]) * 1000 + +m[4];
}

/**
 * Parsea un archivo `.jsonStream`: una línea por mensaje, `HH:MM:SS.mmm` pegado al JSON.
 * Tolera BOM y líneas vacías.
 */
export function parseJsonStream(topic: string, text: string): RawMessage[] {
  const out: RawMessage[] = [];
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    if (!line) continue;
    out.push({ topic, ts: parseStreamTs(line), data: JSON.parse(line.slice(12)) });
  }
  return out;
}

/** Payload de los topics `.z`: base64 → raw deflate → JSON. */
export function decodeZ(b64: string): unknown {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return JSON.parse(strFromU8(inflateSync(bytes)));
}

interface CarBatch {
  Entries: { Utc: string; Cars: Record<string, { Channels: Record<string, number> }> }[];
}

interface PositionBatch {
  Position: { Timestamp: string; Entries: Record<string, { Status: string; X: number; Y: number; Z: number }> }[];
}

/**
 * Deja los mensajes listos para el StateEngine.
 * - `Position.z` trae varias muestras (~5 Hz) por mensaje: se abre en un mensaje `Position` por muestra,
 *   repartidas hacia atrás desde el ts del lote según sus timestamps internos.
 * - `CarData.z` hace lo mismo y deja un mensaje `CarData` por muestra, con `[velocidad, rpm, marcha, acelerador, freno]`
 *   por auto. Canales verificados contra una carrera 2026: 2 velocidad (km/h), 0 rpm, 3 marcha, 4 acelerador
 *   (0 a 104, se recorta a 100) y 5 freno (0 o 100+). No aparece el canal 45 (DRS): ya no hay DRS en 2026.
 * Ambos llevan `utc`, el reloj de la muestra, para poder alinear posiciones con telemetría.
 */
export function normalizeMessage(msg: RawMessage): RawMessage[] {
  if (msg.topic === "Position.z") {
    const batch = (typeof msg.data === "string" ? decodeZ(msg.data) : msg.data) as PositionBatch;
    const samples = batch?.Position ?? [];
    if (!samples.length) return [];
    const lastUtc = Date.parse(samples[samples.length - 1].Timestamp);
    return samples.map((s) => ({
      topic: "Position",
      ts: Math.max(0, msg.ts - (lastUtc - Date.parse(s.Timestamp))),
      utc: Date.parse(s.Timestamp),
      data: s.Entries,
    }));
  }
  if (msg.topic === "CarData.z") {
    const batch = (typeof msg.data === "string" ? decodeZ(msg.data) : msg.data) as CarBatch;
    const entries = batch?.Entries ?? [];
    if (!entries.length) return [];
    const lastUtc = Date.parse(entries[entries.length - 1].Utc);
    return entries.map((e) => {
      const cars: Record<string, number[]> = {};
      for (const num in e.Cars) {
        const ch = e.Cars[num].Channels;
        cars[num] = [ch[2] ?? 0, ch[0] ?? 0, ch[3] ?? 0, Math.min(ch[4] ?? 0, 100), (ch[5] ?? 0) > 0 ? 1 : 0];
      }
      return { topic: "CarData", ts: Math.max(0, msg.ts - (lastUtc - Date.parse(e.Utc))), utc: Date.parse(e.Utc), data: cars };
    });
  }
  return [msg];
}

/** Normaliza y ordena por ts (orden estable: a igual ts se respeta el orden de entrada). */
export function prepareMessages(messages: RawMessage[]): RawMessage[] {
  const out: RawMessage[] = [];
  for (const m of messages) for (const n of normalizeMessage(m)) out.push(n);
  return out
    .map((m, i) => [m, i] as const)
    .sort((a, b) => a[0].ts - b[0].ts || a[1] - b[1])
    .map(([m]) => m);
}
