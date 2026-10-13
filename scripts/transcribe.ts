// Transcribe la radio de los equipos con Whisper y guarda el texto en `transcripts/`, que el sitio publica.
// Corre en TU compu, no en la Action: F1 le responde 403 a GitHub cuando se le piden los audios.
//
// Primera vez:  npm run transcribe:setup      (instala Whisper en .venv-whisper)
// Después:      npm run transcribe            (las sesiones recientes que falten)
//               npm run transcribe -- --session 11388 --model base
// Opciones: --year 2026  --max-sessions 4  --model small  --language en|auto  --session <clave de OpenF1>  --dry-run
// Luego hay que subir los archivos nuevos de transcripts/ a GitHub (git add transcripts && git commit && git push).
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { type RadioTranscripts, radioTranscriptFile } from "@f1/core";
import { listOpenF1Meetings, loadOpenF1Radio } from "@f1/openf1";
import { buildPrompt, type Clip, mergeCache, pendingByFile, serialize, transcribeUrls } from "./transcribe-lib";

const arg = (name: string, fallback?: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
};
const year = Number(arg("year", String(new Date().getUTCFullYear())));
const maxSessions = Number(arg("max-sessions", "4"));
const model = arg("model", "small") as string;
const only = arg("session");
const language = arg("language", "en") as string;
const dry = process.argv.includes("--dry-run");

const outDir = path.resolve("transcripts");
const python = path.resolve(".venv-whisper/bin/python");
if (!dry && !existsSync(python)) {
  console.error("Falta Whisper. Instalalo una vez con: npm run transcribe:setup");
  process.exit(1);
}
await mkdir(outDir, { recursive: true });
const whisper = (prompt: string) => ({ python, script: path.resolve("scripts/transcribe.py"), model, language, prompt });

// Lo que el servicio local transcribió mientras se miraban sesiones se suma a lo publicado.
const cacheDir = arg("cache", path.join(os.homedir(), "Library/Application Support/f1-tracker-auto/radio-cache")) as string;
if (!dry) {
  const merged = await mergeCache(cacheDir, outDir);
  if (merged) console.log(`${merged} mensajes del servicio local sumados a transcripts/`);
}

const readJson = async (file: string): Promise<RadioTranscripts> =>
  JSON.parse(await readFile(path.join(outDir, file), "utf8").catch(() => "{}"));

// Sesiones candidatas: las terminadas hace más de 40 minutos, de la más reciente a la más vieja.
const meetings = await listOpenF1Meetings(year);
const sessions = meetings
  .flatMap((m) => m.sessions.map((s) => ({ key: s.key, label: `${m.name} · ${s.name}`, end: Date.parse(s.endUtc) })))
  .filter((s) => (only ? String(s.key) === only : s.end + 40 * 60_000 < Date.now()))
  .sort((a, b) => b.end - a.end);

let done = 0;
for (const s of sessions) {
  if (done >= maxSessions) break;
  const { clips, drivers } = await loadOpenF1Radio(s.key);
  if (!clips.length) continue;
  const existing: Record<string, RadioTranscripts> = {};
  for (const c of clips) {
    const f = radioTranscriptFile(c.url);
    if (f && !existing[f]) existing[f] = await readJson(f);
  }
  const pending = pendingByFile(clips as Clip[], existing);
  const total = [...pending.values()].reduce((n, l) => n + l.length, 0);
  if (!total) continue;
  console.log(`${s.label}: ${total} mensajes sin transcribir`);
  if (dry) {
    done++;
    continue;
  }

  for (const [file, list] of pending) {
    const result = await transcribeUrls(
      list.map((c) => c.url),
      whisper(buildPrompt(drivers)),
    );
    await writeFile(path.join(outDir, file), serialize({ ...existing[file], ...result }));
    console.log(`  ${file}: ${Object.keys(result).length} transcriptos`);
  }
  done++;
}
console.log(
  done ? `Listo. Subí los cambios: git add transcripts && git commit -m "Transcripciones" && git push` : "No hay nada para transcribir.",
);
