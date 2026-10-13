import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
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

export interface WhisperOptions {
  /** ejecutable de Python con faster-whisper (`.venv-whisper/bin/python`) */
  python: string;
  /** ruta de `scripts/transcribe.py` */
  script: string;
  model: string;
  language: string;
  prompt: string;
}

/** Pasa audios por Whisper (un proceso de Python) y devuelve el texto de cada uno. */
export function runWhisper(items: { id: string; path: string }[], o: WhisperOptions): Promise<RadioTranscripts> {
  return new Promise((resolve, reject) => {
    const child = spawn(o.python, [o.script, "--model", o.model, "--language", o.language, "--prompt", o.prompt], {
      stdio: ["pipe", "pipe", "inherit"],
    });
    let out = "";
    child.stdout.on("data", (b) => {
      out += b;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(`Whisper terminó con error (código ${code})`));
      resolve(JSON.parse(out));
    });
    child.stdin.end(JSON.stringify(items));
  });
}

/**
 * Baja los audios (desde una conexión que F1 acepte) y los transcribe. Devuelve el texto por id.
 * Los que no se pueden bajar se omiten; un 403 corta todo porque quiere decir que esta red no llega a F1.
 */
export async function transcribeUrls(
  urls: string[],
  o: WhisperOptions,
  log: (line: string) => void = console.log,
): Promise<RadioTranscripts> {
  const tmp = await mkdtemp(path.join(tmpdir(), "radio-"));
  try {
    const items: { id: string; path: string }[] = [];
    for (const url of urls) {
      const id = radioId(url);
      if (!id) continue;
      const res = await fetch(url);
      if (res.status === 403) throw new Error(`F1 respondió 403 al pedir ${id}: esta red no llega a los audios.`);
      if (!res.ok) {
        log(`  sin audio (${res.status}): ${id}`);
        continue;
      }
      const p = path.join(tmp, id);
      await writeFile(p, Buffer.from(await res.arrayBuffer()));
      items.push({ id, path: p });
    }
    return items.length ? await runWhisper(items, o) : {};
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/** Suma a `transcripts/` lo que el servicio local transcribió al abrir la página. Lo ya publicado no se pisa. */
export async function mergeCache(cacheDir: string, outDir: string): Promise<number> {
  const files = (await readdir(cacheDir).catch(() => [])).filter((f) => f.endsWith(".json"));
  let added = 0;
  for (const f of files) {
    const cache: RadioTranscripts = JSON.parse(await readFile(path.join(cacheDir, f), "utf8").catch(() => "{}"));
    const target: RadioTranscripts = JSON.parse(await readFile(path.join(outDir, f), "utf8").catch(() => "{}"));
    const fresh = Object.keys(cache).filter((id) => !target[id]);
    if (!fresh.length) continue;
    await mkdir(outDir, { recursive: true });
    await writeFile(path.join(outDir, f), serialize({ ...target, ...Object.fromEntries(fresh.map((id) => [id, cache[id]])) }));
    added += fresh.length;
  }
  return added;
}
