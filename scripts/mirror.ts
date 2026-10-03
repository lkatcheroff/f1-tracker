// Arma los datos del sitio estático: calendario por año + las últimas sesiones ya procesadas.
// Lo corre la GitHub Action cada pocos minutos; solo baja lo que falta.
//
// Fuente: el archivo oficial de F1 si responde (desde una conexión hogareña) y si no, OpenF1.
// F1 le contesta 403 a los servidores de GitHub, así que la Action siempre termina usando OpenF1.
// Uso: tsx scripts/mirror.ts <dir-de-salida> [--max 40]
import { appendFile, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  buildIndex,
  findOutline,
  PACK_VERSION,
  packSession,
  parseJsonStream,
  prepareMessages,
  REPLAY_TOPICS,
  type MeetingEntry,
  type RawMessage,
  type SessionEntry,
} from "@f1/core";
import { listOpenF1Meetings, loadOpenF1Session } from "@f1/openf1";

const BASE = "https://livetiming.formula1.com/static/";
const FIRST_YEAR = 2023;
const outDir = path.resolve(process.argv[2] ?? "site-data");
const maxArg = process.argv.indexOf("--max");
const MAX_SESSIONS = Number(maxArg > -1 ? process.argv[maxArg + 1] : (process.env.MIRROR_MAX_SESSIONS ?? 40));
/** OpenF1 limita a 30 pedidos por minuto y una sesión lleva ~32: se procesan pocas por corrida y el resto, en las siguientes. */
const MAX_NEW_OPENF1 = Number(process.env.MIRROR_MAX_NEW_PER_RUN ?? 5);

const stripBom = (s: string) => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);

async function fetchText(url: string): Promise<string | null> {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
      if (res.status === 403 || res.status === 404) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (err) {
      if (attempt >= 2) throw new Error(`${url}: ${err instanceof Error ? err.message : err}`);
      await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
    }
  }
}

function toUtc(local: string, gmtOffset: string): string {
  const m = /^(-?)(\d+):(\d+)/.exec(gmtOffset ?? "");
  const off = m ? (m[1] ? -1 : 1) * (+m[2] * 60 + +m[3]) * 60_000 : 0;
  return new Date(Date.parse(`${local}Z`) - off).toISOString();
}

async function calendar(year: number): Promise<MeetingEntry[] | null> {
  const text = await fetchText(`${BASE}${year}/Index.json`);
  if (!text) return null;
  return (JSON.parse(stripBom(text)).Meetings ?? []).map((m: any) => ({
    key: m.Key,
    name: m.Name,
    location: m.Location,
    country: m.Country?.Name ?? "",
    sessions: (m.Sessions ?? []).map((s: any) => ({
      key: s.Key,
      name: s.Name,
      type: s.Type,
      startUtc: toUtc(s.StartDate, s.GmtOffset),
      endUtc: toUtc(s.EndDate, s.GmtOffset),
      path: s.Path ?? null,
      data: null,
    })),
  }));
}

async function fromF1(sessionPath: string): Promise<RawMessage[]> {
  const texts = await Promise.all(REPLAY_TOPICS.map((t) => fetchText(`${BASE}${sessionPath}${t}.jsonStream`)));
  const raw: RawMessage[] = [];
  texts.forEach((text, i) => {
    if (text) for (const m of parseJsonStream(REPLAY_TOPICS[i], text)) raw.push(m);
  });
  return raw;
}

async function mirrorSession(s: SessionEntry, file: string): Promise<number> {
  const messages = prepareMessages(s.path ? await fromF1(s.path) : await loadOpenF1Session(s.startUtc, () => {}));
  if (!messages.some((m) => m.topic === "TimingData")) throw new Error("sin TimingData");
  const bytes = packSession({ messages, index: buildIndex(messages), outline: findOutline(messages) });
  await writeFile(file, bytes);
  return bytes.length;
}

const exists = (p: string) => stat(p).then(() => true, () => false);

async function writeIfChanged(file: string, content: string): Promise<boolean> {
  const prev = await readFile(file, "utf8").catch(() => null);
  if (prev === content) return false;
  await writeFile(file, content);
  return true;
}

const sessionsDir = path.join(outDir, "s");
await mkdir(sessionsDir, { recursive: true });
const thisYear = new Date().getUTCFullYear();
let changed = false;

// El archivo de F1 manda si responde; si no (403 desde servidores), todo sale de OpenF1.
// `MIRROR_SOURCE=openf1` fuerza OpenF1 (para probar en local lo que hace la Action).
let meetings = process.env.MIRROR_SOURCE === "openf1" ? null : await calendar(thisYear).catch(() => null);
const useF1 = !!meetings?.length;
if (!useF1) meetings = await listOpenF1Meetings(thisYear);
console.log(`fuente: ${useF1 ? "archivo de F1" : "OpenF1"}`);

// Temporadas anteriores: solo el calendario, una vez (las sesiones se abren vía OpenF1).
for (let y = FIRST_YEAR; y < thisYear; y++) {
  const file = path.join(outDir, `calendar-${y}.json`);
  if (await exists(file)) continue;
  const past = useF1 ? await calendar(y) : await listOpenF1Meetings(y);
  if (past?.length) changed = (await writeIfChanged(file, JSON.stringify(past))) || changed;
}

// Candidatas: con F1, las ya publicadas en su archivo; con OpenF1, las terminadas hace más de 40 minutos.
const now = Date.now();
const published = meetings!
  .flatMap((m) => m.sessions.map((s) => ({ s, label: `${m.name} · ${s.name}` })))
  .filter((x) => (useF1 ? x.s.path : Date.parse(x.s.endUtc) + 40 * 60_000 < now))
  .sort((a, b) => b.s.startUtc.localeCompare(a.s.startUtc))
  .slice(0, MAX_SESSIONS);

const keep = new Set<string>();
const existing = await readdir(sessionsDir);
let added = 0;
for (const { s, label } of published) {
  const name = `${s.key}.v${PACK_VERSION}.json.gz`;
  const file = path.join(sessionsDir, name);
  try {
    if (!(await exists(file))) {
      if (!useF1 && added >= MAX_NEW_OPENF1) {
        // Queda para la próxima corrida. Mientras tanto sigue publicada la versión anterior, si la hay.
        const old = existing.find((n) => n.startsWith(`${s.key}.v`));
        if (old) {
          s.data = `s/${old}`;
          keep.add(old);
        }
        continue;
      }
      const size = await mirrorSession(s, file);
      added++;
      console.log(`nueva: ${label} (${(size / 1048576).toFixed(1)} MB)`);
      changed = true;
    }
    s.data = `s/${name}`;
    keep.add(name);
  } catch (err) {
    // Una sesión que falla no frena al resto: se reintenta en la próxima corrida.
    console.warn(`no se pudo procesar ${label}: ${err instanceof Error ? err.message : err}`);
  }
}

for (const name of await readdir(sessionsDir)) {
  if (keep.has(name)) continue;
  await rm(path.join(sessionsDir, name));
  console.log(`fuera de la ventana: ${name}`);
  changed = true;
}

// El calendario publicado no lleva `path`: el sitio estático no puede leer el archivo de F1.
for (const m of meetings!) for (const s of m.sessions) s.path = null;
changed = (await writeIfChanged(path.join(outDir, `calendar-${thisYear}.json`), JSON.stringify(meetings))) || changed;

console.log(`${keep.size} sesiones publicadas, cambios: ${changed}`);
if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `changed=${changed}\n`);
