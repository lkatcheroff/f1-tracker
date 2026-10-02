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

interface PositionBatch {
  Position: { Timestamp: string; Entries: Record<string, { Status: string; X: number; Y: number; Z: number }> }[];
}

/**
 * Deja los mensajes listos para el StateEngine.
 * - `Position.z` trae varias muestras (~5 Hz) por mensaje: se abre en un mensaje `Position` por muestra,
 *   repartidas hacia atrás desde el ts del lote según sus timestamps internos.
 * - `CarData.z` queda fuera del MVP: se descarta (el Recorder guarda el crudo antes de este paso).
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
      data: s.Entries,
    }));
  }
  if (msg.topic === "CarData.z") return [];
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
