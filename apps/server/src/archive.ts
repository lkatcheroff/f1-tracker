import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseJsonStream, REPLAY_TOPICS, type MeetingEntry, type RawMessage } from "@f1/core";
import { cacheDir, config } from "./config";

const REQUIRED = ["TimingData", "DriverList"];

const stripBom = (s: string) => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);

async function fetchText(url: string): Promise<string | null> {
  const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (res.status === 403 || res.status === 404) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status} en ${url}`);
  return res.text();
}

const indexCache = new Map<number, { at: number; meetings: MeetingEntry[] }>();

/** Local + offset ("2026-09-26T15:00:00", "04:00:00") → ISO UTC */
function toUtc(local: string, gmtOffset: string): string {
  const m = /^(-?)(\d+):(\d+)/.exec(gmtOffset ?? "");
  const off = m ? (m[1] ? -1 : 1) * (+m[2] * 60 + +m[3]) * 60_000 : 0;
  return new Date(Date.parse(`${local}Z`) - off).toISOString();
}

/** Calendario del año según `Index.json`. Solo nombres y horarios: nada que revele resultados. */
export async function listMeetings(year: number): Promise<MeetingEntry[]> {
  const hit = indexCache.get(year);
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit.meetings;
  const text = await fetchText(`${config.staticBase}${year}/Index.json`);
  if (!text) return [];
  const data = JSON.parse(stripBom(text));
  const meetings: MeetingEntry[] = (data.Meetings ?? []).map((m: any) => ({
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
    })),
  }));
  indexCache.set(year, { at: Date.now(), meetings });
  return meetings;
}

/**
 * Baja (o lee de la caché en disco) los streams de una sesión del archivo estático.
 * Devuelve null si F1 todavía no la publicó.
 */
export async function loadStaticSession(sessionPath: string, onStep: (s: string) => void): Promise<RawMessage[] | null> {
  if (!/^\d{4}\/[\w.-]+\/[\w.-]+\/$/.test(sessionPath)) throw new Error(`path de sesión inválido: ${sessionPath}`);
  const dir = cacheDir("static", ...sessionPath.split("/").filter(Boolean));
  await mkdir(dir, { recursive: true });

  const texts = await Promise.all(
    REPLAY_TOPICS.map(async (topic) => {
      const file = path.join(dir, `${topic}.jsonStream`);
      try {
        return await readFile(file, "utf8");
      } catch {
        onStep(`bajando ${topic}`);
        const text = await fetchText(`${config.staticBase}${sessionPath}${topic}.jsonStream`);
        if (text !== null) await writeFile(file, text);
        return text;
      }
    }),
  );
  if (REQUIRED.some((t) => texts[REPLAY_TOPICS.indexOf(t)] === null)) return null;

  onStep("procesando");
  const out: RawMessage[] = [];
  texts.forEach((text, i) => {
    if (text) for (const m of parseJsonStream(REPLAY_TOPICS[i], text)) out.push(m);
  });
  return out;
}
