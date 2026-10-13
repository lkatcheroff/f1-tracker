// Servicio local de transcripción de la radio. Escucha en 127.0.0.1 y lo usa la página cuando la abrís en esta compu.
// Se instala como servicio con: npm run transcribe:auto:install (junto con la tarea que transcribe y sube).
// A mano: npm run radio-helper   (--port 8788  --model small  --cache <carpeta>)
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHelperServer, RadioQueue } from "./radio-helper-lib";
import { buildPrompt, serialize, transcribeUrls } from "./transcribe-lib";

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? (process.argv[i + 1] as string) : fallback;
};
const port = Number(arg("port", "8788"));
const model = arg("model", "small");
const cacheDir = arg("cache", path.join(os.homedir(), "Library/Application Support/f1-tracker-auto/radio-cache"));
const publishedDir = path.resolve("transcripts");
const python = path.resolve(".venv-whisper/bin/python");
const stamp = () => new Date().toISOString().replace("T", " ").slice(0, 19);
const log = (line: string) => console.log(`[${stamp()}] ${line}`);

if (!existsSync(python)) {
  console.error("Falta Whisper. Instalalo una vez con: npm run transcribe:setup");
  process.exit(1);
}
await mkdir(cacheDir, { recursive: true });

const readJson = (dir: string) => async (file: string) => JSON.parse(await readFile(path.join(dir, file), "utf8").catch(() => "{}"));

const queue = new RadioQueue({
  readPublished: readJson(publishedDir),
  readCache: readJson(cacheDir),
  writeCache: (file, t) => writeFile(path.join(cacheDir, file), serialize(t)),
  work: (urls, drivers) =>
    transcribeUrls(
      urls,
      { python, script: path.resolve("scripts/transcribe.py"), model, language: "en", prompt: buildPrompt(drivers) },
      log,
    ),
  log,
});

createHelperServer(queue, { model }).listen(port, "127.0.0.1", () =>
  log(`servicio de radio en http://127.0.0.1:${port} (modelo ${model})`),
);
