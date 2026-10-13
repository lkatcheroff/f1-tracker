import { type RadioTranscripts, radioId, radioTranscriptFile } from "@f1/core";

export interface Clip {
  date: string;
  driver: number;
  url: string;
}

/** Lo que se le sugiere a Whisper: nombres y jerga de la radio. Mejora mucho los apellidos y las palabras propias de F1. */
export function buildPrompt(driverNames: string[]): string {
  const names = [...new Set(driverNames)].join(", ");
  return [
    "Formula 1 team radio.",
    names ? `Drivers: ${names}.` : "",
    "Box, box. Plan A, plan B. Tyres, softs, mediums, hards, inters, wets. DRS, undercut, overcut, safety car, virtual safety car, red flag, pit lane, stint, delta, lift and coast, deployment, brake balance, differential, copy, understood, push, gap.",
  ]
    .filter(Boolean)
    .join(" ");
}

/** Mensajes que todavía no tienen transcripción, agrupados por el archivo donde se guardan. */
export function pendingByFile(clips: Clip[], existing: Record<string, RadioTranscripts>): Map<string, Clip[]> {
  const out = new Map<string, Clip[]>();
  for (const c of clips) {
    const file = radioTranscriptFile(c.url);
    const id = radioId(c.url);
    if (!file || !id || existing[file]?.[id]) continue;
    out.set(file, [...(out.get(file) ?? []), c]);
  }
  return out;
}

/** Serializa un archivo de transcripciones: un mensaje por línea y en orden, para que los cambios se lean en git. */
export function serialize(t: RadioTranscripts): string {
  const keys = Object.keys(t).sort();
  return `{\n${keys.map((k) => `  ${JSON.stringify(k)}: ${JSON.stringify(t[k])}`).join(",\n")}\n}\n`;
}
