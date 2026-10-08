// Arma los datos del sitio estático: calendario por año + las últimas sesiones ya procesadas.
// Es la lógica del espejo, sin leer el entorno ni la red por su cuenta: todo lo externo entra por `MirrorDeps`,
// así se prueba con respuestas de mentira. El ejecutable es `scripts/mirror.ts`.
import { appendFile, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  buildIndex,
  buildTelemetry,
  findOutline,
  type MeetingEntry,
  PACK_VERSION,
  packSession,
  packTelemetry,
  parseJsonStream,
  prepareMessages,
  type RawMessage,
  REPLAY_TOPICS,
  type SessionEntry,
  TELEMETRY_VERSION,
} from "@f1/core";

const BASE = "https://livetiming.formula1.com/static/";
const FIRST_YEAR = 2023;

export interface MirrorDeps {
  /** Texto de una URL del archivo de F1, o `null` si no está disponible (403 y 404). */
  fetchText(url: string): Promise<string | null>;
  loadOpenF1(startUtc: string): Promise<RawMessage[]>;
  listOpenF1(year: number): Promise<MeetingEntry[]>;
  now(): number;
  log(line: string): void;
}

export interface MirrorOptions {
  outDir: string;
  /** Cuántas sesiones se publican como máximo (las más recientes). */
  maxSessions: number;
  /** Cuántas sesiones nuevas se procesan por corrida cuando la fuente es OpenF1. */
  maxNewOpenF1: number;
  /** Ignora el archivo de F1 y usa OpenF1 (para probar en local lo que hace la Action). */
  forceOpenF1?: boolean;
  /** Archivo donde se escribe `changed=true|false` (el `GITHUB_OUTPUT` de la Action). */
  githubOutput?: string;
}

export interface MirrorResult {
  changed: boolean;
  source: "f1" | "openf1";
  /** Sesiones procesadas en esta corrida. */
  added: string[];
  /** Sesiones que fallaron y se reintentan en la próxima. */
  failed: string[];
  published: number;
}

const stripBom = (s: string) => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);

function toUtc(local: string, gmtOffset: string): string {
  const m = /^(-?)(\d+):(\d+)/.exec(gmtOffset ?? "");
  const off = m ? (m[1] ? -1 : 1) * (+m[2] * 60 + +m[3]) * 60_000 : 0;
  return new Date(Date.parse(`${local}Z`) - off).toISOString();
}

const exists = (p: string) =>
  stat(p).then(
    () => true,
    () => false,
  );

async function writeIfChanged(file: string, content: string): Promise<boolean> {
  const prev = await readFile(file, "utf8").catch(() => null);
  if (prev === content) return false;
  await writeFile(file, content);
  return true;
}

export async function mirror(opts: MirrorOptions, deps: MirrorDeps): Promise<MirrorResult> {
  const { outDir } = opts;

  async function calendar(year: number): Promise<MeetingEntry[] | null> {
    const text = await deps.fetchText(`${BASE}${year}/Index.json`);
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
    const texts = await Promise.all(REPLAY_TOPICS.map((t) => deps.fetchText(`${BASE}${sessionPath}${t}.jsonStream`)));
    const raw: RawMessage[] = [];
    texts.forEach((text, i) => {
      if (text) for (const m of parseJsonStream(REPLAY_TOPICS[i], text)) raw.push(m);
    });
    return raw;
  }

  /** Escribe la sesión y su telemetría. Si no hay telemetría que armar, deja un marcador vacío para no reintentar siempre. */
  async function mirrorSession(s: SessionEntry, file: string, telFile: string): Promise<{ size: number; tel: number | null }> {
    const raw = s.path ? await fromF1(s.path) : await deps.loadOpenF1(s.startUtc);
    const messages = prepareMessages(raw);
    if (!messages.some((m) => m.topic === "TimingData")) throw new Error("sin TimingData");
    const outline = findOutline(messages);
    const bytes = packSession({ messages, index: buildIndex(messages), outline, origin: s.path ? "official" : "openf1" });

    const tel = buildTelemetry(messages, outline);
    const telBytes = tel ? packTelemetry(tel) : null;
    // Primero la telemetría: si el proceso se corta entre los dos, la sesión falta y se rehace todo en la próxima corrida.
    await writeFile(telFile, telBytes ?? "");
    await writeFile(file, bytes);
    return { size: bytes.length, tel: telBytes?.length ?? null };
  }

  const sessionsDir = path.join(outDir, "s");
  const telemetryDir = path.join(outDir, "t");
  await mkdir(sessionsDir, { recursive: true });
  await mkdir(telemetryDir, { recursive: true });
  const thisYear = new Date(deps.now()).getUTCFullYear();
  let changed = false;

  // El archivo de F1 manda si responde; si no (403 desde servidores), todo sale de OpenF1.
  let meetings = opts.forceOpenF1 ? null : await calendar(thisYear).catch(() => null);
  const useF1 = !!meetings?.length;
  if (!useF1) meetings = await deps.listOpenF1(thisYear);
  deps.log(`fuente: ${useF1 ? "archivo de F1" : "OpenF1"}`);

  // Temporadas anteriores: solo el calendario, una vez (las sesiones se abren vía OpenF1).
  for (let y = FIRST_YEAR; y < thisYear; y++) {
    const file = path.join(outDir, `calendar-${y}.json`);
    if (await exists(file)) continue;
    const past = useF1 ? await calendar(y) : await deps.listOpenF1(y);
    if (past?.length) changed = (await writeIfChanged(file, JSON.stringify(past))) || changed;
  }

  // Candidatas: con F1, las ya publicadas en su archivo; con OpenF1, las terminadas hace más de 40 minutos.
  const now = deps.now();
  const candidates = meetings!
    .flatMap((m) => m.sessions.map((s) => ({ s, label: `${m.name} · ${s.name}` })))
    .filter((x) => (useF1 ? x.s.path : Date.parse(x.s.endUtc) + 40 * 60_000 < now))
    .sort((a, b) => b.s.startUtc.localeCompare(a.s.startUtc))
    .slice(0, opts.maxSessions);

  const keep = new Set<string>();
  const existing = await readdir(sessionsDir);
  const added: string[] = [];
  const failed: string[] = [];
  /** Mientras no se pueda regenerar una sesión, sigue publicada la versión anterior (si la hay). */
  const keepOld = (s: SessionEntry) => {
    const old = existing.find((n) => n.startsWith(`${s.key}.v`));
    if (!old) return;
    s.data = `s/${old}`;
    keep.add(old);
  };
  for (const { s, label } of candidates) {
    const name = `${s.key}.v${PACK_VERSION}.json.gz`;
    const file = path.join(sessionsDir, name);
    const telFile = path.join(telemetryDir, `${s.key}.v${TELEMETRY_VERSION}.json.gz`);
    try {
      if (!(await exists(file)) || !(await exists(telFile))) {
        if (!useF1 && added.length >= opts.maxNewOpenF1) {
          // Queda para la próxima corrida.
          keepOld(s);
          continue;
        }
        const { size, tel } = await mirrorSession(s, file, telFile);
        added.push(label);
        deps.log(
          `nueva: ${label} (${(size / 1048576).toFixed(1)} MB, telemetría ${tel === null ? "no disponible" : `${(tel / 1048576).toFixed(1)} MB`})`,
        );
        changed = true;
      }
      s.data = `s/${name}`;
      keep.add(name);
    } catch (err) {
      // Una sesión que falla no frena al resto ni borra lo publicado: se reintenta en la próxima corrida.
      deps.log(`no se pudo procesar ${label}: ${err instanceof Error ? err.message : err}`);
      failed.push(label);
      keepOld(s);
    }
  }

  for (const name of await readdir(sessionsDir)) {
    if (keep.has(name)) continue;
    await rm(path.join(sessionsDir, name));
    deps.log(`fuera de la ventana: ${name}`);
    changed = true;
  }

  // La telemetría solo se conserva de las sesiones que siguen publicadas.
  const keptKeys = new Set([...keep].map((n) => n.split(".")[0]));
  for (const name of await readdir(telemetryDir)) {
    if (keptKeys.has(name.split(".")[0])) continue;
    await rm(path.join(telemetryDir, name));
    changed = true;
  }

  // El calendario publicado no lleva `path`: el sitio estático no puede leer el archivo de F1.
  for (const m of meetings!) for (const s of m.sessions) s.path = null;
  changed = (await writeIfChanged(path.join(outDir, `calendar-${thisYear}.json`), JSON.stringify(meetings))) || changed;

  deps.log(`${keep.size} sesiones publicadas, cambios: ${changed}`);
  if (opts.githubOutput) await appendFile(opts.githubOutput, `changed=${changed}\n`);
  return { changed, source: useF1 ? "f1" : "openf1", added, failed, published: keep.size };
}

/** `fetch` del archivo de F1 con reintentos: 403 y 404 se leen como "no disponible". */
export async function fetchText(url: string, fetchFn: typeof fetch = fetch, wait = (ms: number) => new Promise((r) => setTimeout(r, ms))) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetchFn(url, { signal: AbortSignal.timeout(120_000) });
      if (res.status === 403 || res.status === 404) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (err) {
      if (attempt >= 2) throw new Error(`${url}: ${err instanceof Error ? err.message : err}`);
      await wait(3000 * (attempt + 1));
    }
  }
}
