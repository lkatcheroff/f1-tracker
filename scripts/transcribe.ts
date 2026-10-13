// Transcribe la radio de los equipos con Whisper y guarda el texto en `transcripts/`, que el sitio publica.
// Corre en TU compu, no en la Action: F1 le responde 403 a GitHub cuando se le piden los audios.
//
// Primera vez:  npm run transcribe:setup      (instala Whisper en .venv-whisper)
// Después:      npm run transcribe            (las sesiones recientes que falten)
//               npm run transcribe -- --session 11388 --model base
// Opciones: --year 2026  --max-sessions 4  --model small  --session <clave de OpenF1>  --dry-run
// Luego hay que subir los archivos nuevos de transcripts/ a GitHub (git add transcripts && git commit && git push).
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type RadioTranscripts, radioId, radioTranscriptFile } from "@f1/core";
import { listOpenF1Meetings, loadOpenF1Radio } from "@f1/openf1";
import { buildPrompt, type Clip, pendingByFile, serialize } from "./transcribe-lib";

const arg = (name: string, fallback?: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
};
const year = Number(arg("year", String(new Date().getUTCFullYear())));
const maxSessions = Number(arg("max-sessions", "4"));
const model = arg("model", "small") as string;
const only = arg("session");
const dry = process.argv.includes("--dry-run");

const outDir = path.resolve("transcripts");
const python = path.resolve(".venv-whisper/bin/python");
if (!dry && !existsSync(python)) {
  console.error("Falta Whisper. Instalalo una vez con: npm run transcribe:setup");
  process.exit(1);
}
await mkdir(outDir, { recursive: true });

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

  const tmp = await mkdtemp(path.join(tmpdir(), "radio-"));
  try {
    for (const [file, list] of pending) {
      // Descarga de los audios (desde esta red F1 responde; desde GitHub, no).
      const items: { id: string; path: string }[] = [];
      for (const c of list) {
        const id = radioId(c.url) as string;
        const res = await fetch(c.url);
        if (res.status === 403) throw new Error(`F1 respondió 403 al pedir ${id}: esta red no llega a los audios.`);
        if (!res.ok) {
          console.warn(`  sin audio (${res.status}): ${id}`);
          continue;
        }
        const p = path.join(tmp, id);
        await writeFile(p, Buffer.from(await res.arrayBuffer()));
        items.push({ id, path: p });
      }
      const result = await run(items, buildPrompt(drivers));
      const merged = { ...existing[file], ...result };
      await writeFile(path.join(outDir, file), serialize(merged));
      console.log(`  ${file}: ${Object.keys(result).length} transcriptos`);
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
  done++;
}
console.log(
  done ? `Listo. Subí los cambios: git add transcripts && git commit -m "Transcripciones" && git push` : "No hay nada para transcribir.",
);

function run(items: { id: string; path: string }[], prompt: string): Promise<RadioTranscripts> {
  return new Promise((resolve, reject) => {
    const child = spawn(python, ["scripts/transcribe.py", "--model", model, "--prompt", prompt], { stdio: ["pipe", "pipe", "inherit"] });
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
