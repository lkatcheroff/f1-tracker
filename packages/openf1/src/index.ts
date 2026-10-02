import type { MeetingEntry, RawMessage } from "@f1/core";

const BASE = "https://api.openf1.org/v1/";
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Fallback del replay: arma la sesión a partir del histórico gratuito de OpenF1 (REST normalizado)
 * y la traduce al formato de mensajes del feed de F1, así la consume el mismo StateEngine.
 * Es una reconstrucción: no trae retiros ni estado de sesión, y el estado de pista se deduce de
 * los mensajes de Race Control.
 * Solo usa `fetch`: corre igual en el server y en el navegador (OpenF1 acepta pedidos de cualquier origen).
 */

type Row = Record<string, any>;

// --- cliente HTTP con el rate limit del plan gratuito: 3 req/s y 30 req/min ---

const sent: number[] = [];
let gate: Promise<void> = Promise.resolve();

function slot(): Promise<void> {
  const next = gate.then(async () => {
    for (;;) {
      const now = Date.now();
      while (sent.length && now - sent[0] > 60_000) sent.shift();
      const sinceLast = now - (sent[sent.length - 1] ?? 0);
      if (sent.length < 28 && sinceLast >= 400) break;
      await sleep(sent.length >= 28 ? 60_000 - (now - sent[0]) + 50 : 400 - sinceLast);
    }
    sent.push(Date.now());
  });
  gate = next.catch(() => {});
  return next;
}

async function get(endpoint: string, params: Record<string, string | number>): Promise<Row[]> {
  // OpenF1 usa operadores en la clave (`date>...`), así que la query se arma a mano.
  const qs = Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k).replace(/%3E/g, ">").replace(/%3C/g, "<")}${/[<>]$/.test(k) ? "" : "="}${encodeURIComponent(v)}`)
    .join("&");
  for (let attempt = 0; ; attempt++) {
    await slot();
    const res = await fetch(`${BASE}${endpoint}?${qs}`, { signal: AbortSignal.timeout(120_000) });
    if (res.status === 404) return [];
    if (res.status === 429 && attempt < 3) {
      await sleep(5000 * (attempt + 1));
      continue;
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`OpenF1 respondió HTTP ${res.status} en ${endpoint}${detail ? `: ${detail.slice(0, 160)}` : ""}`);
    }
    const body = await res.json();
    return Array.isArray(body) ? body : [];
  }
}

// --- traducción al formato del feed ---

const fmtLap = (sec: number) => {
  const m = Math.floor(sec / 60);
  const s = (sec - m * 60).toFixed(3).padStart(6, "0");
  return m ? `${m}:${s}` : (sec - m * 60).toFixed(3);
};

const fmtGap = (v: unknown): string => {
  if (typeof v === "number") return v > 0 ? `+${v.toFixed(3)}` : "";
  const m = /(\d+)\s*L/i.exec(String(v ?? ""));
  return m ? `${m[1]}L` : "";
};

interface OpenF1Data {
  session: Row;
  meeting: Row | undefined;
  drivers: Row[];
  laps: Row[];
  intervals: Row[];
  position: Row[];
  stints: Row[];
  pit: Row[];
  raceControl: Row[];
  weather: Row[];
  /** Resultado final: solo se usa para saber quién abandonó (y se emite recién en el momento del abandono). */
  results: Row[];
  /** Posiciones aplanadas de a cuatro: nº de auto, epoch ms, x, y. */
  location: number[];
}

export function adaptOpenF1(d: OpenF1Data): RawMessage[] {
  const out: RawMessage[] = [];
  const isRace = d.session.session_type === "Race";
  let t0 = Date.parse(d.session.date_start);
  for (const rows of [d.raceControl, d.weather, d.position, d.intervals]) {
    for (const r of rows) {
      const t = Date.parse(r.date);
      if (t < t0) t0 = t;
    }
  }
  for (let i = 1; i < d.location.length; i += 4) if (d.location[i] < t0) t0 = d.location[i];
  const at = (iso: string) => Math.max(0, Date.parse(iso) - t0);
  const push = (topic: string, ts: number, data: unknown) => out.push({ topic, ts, data });
  const line = (ts: number, num: number | string, data: Row) => push("TimingData", ts, { Lines: { [num]: data } });

  push("Heartbeat", 0, { Utc: new Date(t0).toISOString() });
  push("SessionInfo", 0, {
    Meeting: {
      Name: d.meeting?.meeting_name ?? `${d.session.country_name} Grand Prix`,
      Country: { Name: d.session.country_name },
      Circuit: { Key: d.session.circuit_key, ShortName: d.session.circuit_short_name },
    },
    Name: d.session.session_name,
    Type: d.session.session_type,
    StartDate: d.session.date_start,
    Path: null,
  });
  push(
    "DriverList",
    0,
    Object.fromEntries(
      d.drivers.map((r) => [
        r.driver_number,
        {
          RacingNumber: String(r.driver_number),
          Tla: r.name_acronym,
          FullName: r.full_name,
          BroadcastName: r.broadcast_name,
          TeamName: r.team_name,
          TeamColour: r.team_colour,
        },
      ]),
    ),
  );

  // Orden inicial: la primera posición conocida de cada piloto.
  const firstPos = new Map<number, number>();
  for (const r of d.position) if (!firstPos.has(r.driver_number)) firstPos.set(r.driver_number, r.position);
  const blank = { Value: "", PersonalFastest: false, OverallFastest: false };
  push("TimingData", 0, {
    Lines: Object.fromEntries(
      d.drivers.map((r, i) => {
        const p = firstPos.get(r.driver_number) ?? i + 1;
        return [
          r.driver_number,
          {
            RacingNumber: String(r.driver_number),
            Line: p,
            Position: String(p),
            NumberOfLaps: 0,
            InPit: false,
            Sectors: [{ ...blank }, { ...blank }, { ...blank }],
            LastLapTime: { ...blank },
            BestLapTime: { Value: "" },
          },
        ];
      }),
    ),
  });
  push("TimingAppData", 0, {
    Lines: Object.fromEntries(d.drivers.map((r) => [r.driver_number, { RacingNumber: String(r.driver_number), Stints: [] }])),
  });
  push("SessionStatus", 0, { Status: "Inactive" });
  push("TrackStatus", 0, { Status: "1", Message: "AllClear" });

  for (const r of d.position) line(at(r.date), r.driver_number, { Position: String(r.position), Line: r.position });

  if (isRace) {
    for (const r of d.intervals) {
      line(at(r.date), r.driver_number, {
        GapToLeader: fmtGap(r.gap_to_leader),
        IntervalToPositionAhead: { Value: fmtGap(r.interval) },
      });
    }
  }

  // Vueltas y sectores: se ordenan en el tiempo para poder marcar mejores personales y absolutos.
  const byDriver = new Map<number, Row[]>();
  for (const r of d.laps) {
    if (!byDriver.has(r.driver_number)) byDriver.set(r.driver_number, []);
    byDriver.get(r.driver_number)!.push(r);
  }
  type Ev = { ts: number; num: number; lap: number } & ({ kind: "sector"; i: number; v: number } | { kind: "lap"; v: number | null });
  const events: Ev[] = [];
  const lapStart = new Map<string, number>();
  const lapStarts: { ts: number; lap: number }[] = [];
  for (const [num, rows] of byDriver) {
    rows.sort((a, b) => a.lap_number - b.lap_number);
    rows.forEach((r, idx) => {
      if (!r.date_start) return;
      const start = at(r.date_start);
      lapStart.set(`${num}:${r.lap_number}`, start);
      lapStarts.push({ ts: start, lap: r.lap_number });
      if (r.is_pit_out_lap) line(start, num, { PitOut: true });
      let t = start;
      [r.duration_sector_1, r.duration_sector_2, r.duration_sector_3].forEach((v, i) => {
        if (typeof v !== "number") return;
        t += v * 1000;
        events.push({ ts: t, num, lap: r.lap_number, kind: "sector", i, v });
      });
      const nextStart = rows[idx + 1]?.date_start;
      const end = typeof r.lap_duration === "number" ? start + r.lap_duration * 1000 : nextStart ? at(nextStart) : null;
      if (end !== null) events.push({ ts: end, num, lap: r.lap_number, kind: "lap", v: r.lap_duration ?? null });
    });
  }
  events.sort((a, b) => a.ts - b.ts);

  const stintOf = (num: number, lap: number) => d.stints.find((s) => s.driver_number === num && lap >= s.lap_start && lap <= (s.lap_end ?? Infinity));
  const bestSector: Record<string, number> = {};
  const bestLap = new Map<number, number>();
  let fastest = Infinity;
  for (const e of events) {
    if (e.kind === "sector") {
      const pbKey = `${e.num}:${e.i}`;
      const pb = e.v < (bestSector[pbKey] ?? Infinity);
      const ob = e.v < (bestSector[`all:${e.i}`] ?? Infinity);
      if (pb) bestSector[pbKey] = e.v;
      if (ob) bestSector[`all:${e.i}`] = e.v;
      const sectors: Row = { [e.i]: { Value: e.v.toFixed(3), PersonalFastest: pb, OverallFastest: ob } };
      if (e.i === 0) sectors[1] = sectors[2] = { ...blank }; // empieza vuelta nueva
      line(e.ts, e.num, { Sectors: sectors });
      continue;
    }
    const delta: Row = { NumberOfLaps: e.lap, PitOut: false };
    if (e.v !== null) {
      const pb = e.v < (bestLap.get(e.num) ?? Infinity);
      const ob = e.v < fastest;
      if (pb) bestLap.set(e.num, e.v);
      if (ob) fastest = e.v;
      delta.LastLapTime = { Value: fmtLap(e.v), PersonalFastest: pb, OverallFastest: ob };
      if (pb) delta.BestLapTime = { Value: fmtLap(e.v) };
      // Fuera de carrera no hay `intervals`: la diferencia es contra la mejor vuelta de la sesión.
      if (!isRace && (pb || ob)) {
        for (const [num, best] of bestLap) line(e.ts, num, { TimeDiffToFastest: best > fastest ? `+${(best - fastest).toFixed(3)}` : "" });
      }
    }
    line(e.ts, e.num, delta);
    const st = stintOf(e.num, e.lap);
    if (st) {
      push("TimingAppData", e.ts, {
        Lines: { [e.num]: { Stints: { [st.stint_number - 1]: { TotalLaps: (st.tyre_age_at_start ?? 0) + e.lap - st.lap_start + 1 } } } },
      });
    }
  }

  for (const s of d.stints) {
    const ts = s.stint_number === 1 ? 0 : (lapStart.get(`${s.driver_number}:${s.lap_start}`) ?? null);
    if (ts === null) continue;
    const age = s.tyre_age_at_start ?? 0;
    push("TimingAppData", ts, {
      Lines: {
        [s.driver_number]: {
          Stints: { [s.stint_number - 1]: { Compound: s.compound ?? "UNKNOWN", New: String(age === 0), TotalLaps: age, StartLaps: age } },
        },
      },
    });
  }

  // Abandonos: OpenF1 no da el instante. Se marca al minuto de su última vuelta completa,
  // o a los 45 s de empezar la vuelta que no terminó.
  for (const r of d.results) {
    if (!r.dnf) continue;
    const rows = byDriver.get(r.driver_number);
    const last = rows?.filter((l) => l.date_start).at(-1);
    if (!last) continue;
    const start = at(last.date_start);
    const ts = typeof last.lap_duration === "number" ? start + last.lap_duration * 1000 + 60_000 : start + 45_000;
    line(ts, r.driver_number, { Stopped: true });
  }

  const stops = new Map<number, number>();
  for (const r of [...d.pit].sort((a, b) => Date.parse(a.date) - Date.parse(b.date))) {
    const n = (stops.get(r.driver_number) ?? 0) + 1;
    stops.set(r.driver_number, n);
    const ts = at(r.date);
    line(ts, r.driver_number, { InPit: true, NumberOfPitStops: n });
    line(ts + (r.lane_duration ?? r.pit_duration ?? 22) * 1000, r.driver_number, { InPit: false });
  }

  if (isRace) {
    const totalLaps = Math.max(0, ...d.laps.map((r) => r.lap_number));
    push("LapCount", 0, { CurrentLap: 1, TotalLaps: totalLaps });
    let current = 1;
    for (const l of lapStarts.sort((a, b) => a.ts - b.ts)) {
      if (l.lap > current) push("LapCount", l.ts, { CurrentLap: (current = l.lap) });
    }
    const first = lapStarts.find((l) => l.lap === 1);
    if (first) push("SessionStatus", first.ts, { Status: "Started" });
  }

  // Race Control tal cual; el estado de pista y de sesión se deduce de sus mensajes (aproximado).
  let sc = false;
  let aborted = false;
  d.raceControl.forEach((r, i) => {
    const ts = at(r.date);
    const msg: Row = {
      Utc: String(r.date).replace(/(\.\d+)?([+-]\d\d:\d\d|Z)$/, ""),
      Lap: r.lap_number ?? undefined,
      Category: r.category,
      Flag: r.flag ?? undefined,
      Scope: r.scope ?? undefined,
      Sector: r.sector ?? undefined,
      RacingNumber: r.driver_number != null ? String(r.driver_number) : undefined,
      Message: r.message,
    };
    push("RaceControlMessages", ts, { Messages: i === 0 ? [msg] : { [i]: msg } });

    const text = String(r.message ?? "").toUpperCase();
    const track = (status: string, message: string) => push("TrackStatus", ts, { Status: status, Message: message });
    if (r.category === "SafetyCar") {
      if (text.includes("VIRTUAL") && text.includes("DEPLOYED")) (sc = true), track("6", "VSCDeployed");
      else if (text.includes("VIRTUAL") && text.includes("ENDING")) track("7", "VSCEnding");
      else if (text.includes("DEPLOYED")) (sc = true), track("4", "SCDeployed");
    } else if (r.flag === "RED") {
      aborted = true;
      track("5", "Red");
      push("SessionStatus", ts, { Status: "Aborted" });
    } else if (r.flag === "CHEQUERED") {
      push("SessionStatus", ts, { Status: "Finished" });
    } else if (r.flag === "GREEN" || (r.flag === "CLEAR" && r.scope === "Track")) {
      sc = false;
      track("1", "AllClear");
      if (text.includes("PIT EXIT OPEN") && (!isRace || aborted)) {
        aborted = false;
        push("SessionStatus", ts, { Status: "Started" });
      }
    } else if (!sc && (r.flag === "YELLOW" || r.flag === "DOUBLE YELLOW")) {
      track("2", "Yellow");
    } else if (!sc && r.flag === "CLEAR") {
      track("1", "AllClear");
    }
  });

  for (const r of d.weather) {
    push("WeatherData", at(r.date), {
      AirTemp: String(r.air_temperature),
      TrackTemp: String(r.track_temperature),
      Humidity: String(r.humidity),
      Rainfall: String(r.rainfall),
      WindSpeed: String(r.wind_speed),
      WindDirection: String(r.wind_direction),
    });
  }

  // Posiciones: una muestra por auto cada ~260 ms; se agrupan en mensajes `Position` de 250 ms.
  const buckets = new Map<number, Row>();
  for (let i = 0; i < d.location.length; i += 4) {
    const b = Math.floor((d.location[i + 1] - t0) / 250);
    if (!buckets.has(b)) buckets.set(b, {});
    buckets.get(b)![d.location[i]] = [d.location[i + 2], d.location[i + 3], 1];
  }
  for (const [b, entries] of buckets) push("Position", (b + 1) * 250, entries);

  return out;
}

// --- carga ---

let sessionsCache: { year: number; at: number; rows: Row[] } | null = null;

async function findSession(startUtc: string): Promise<Row> {
  const start = Date.parse(startUtc);
  if (!Number.isFinite(start)) throw new Error(`referencia de sesión inválida: ${startUtc}`);
  const year = new Date(start).getUTCFullYear();
  if (!sessionsCache || sessionsCache.year !== year || Date.now() - sessionsCache.at > 5 * 60_000) {
    sessionsCache = { year, at: Date.now(), rows: await get("sessions", { year }) };
  }
  const best = sessionsCache.rows
    .map((r) => ({ r, diff: Math.abs(Date.parse(r.date_start) - start) }))
    .sort((a, b) => a.diff - b.diff)[0];
  if (!best || best.diff > 3 * 3600_000) throw new Error("OpenF1 no tiene una sesión en ese horario");
  return best.r;
}

export interface OpenF1Session {
  /** `session_key` de OpenF1 */
  key: number;
  /** ISO en UTC */
  endUtc: string;
}

/** Ubica la sesión de OpenF1 que empieza a esa hora (inicio en UTC, ISO, tal como figura en el calendario). */
export async function findOpenF1Session(startUtc: string): Promise<OpenF1Session> {
  const s = await findSession(startUtc);
  return { key: s.session_key, endUtc: new Date(s.date_end).toISOString() };
}

/** Baja la sesión entera de OpenF1 y la devuelve como mensajes del feed de F1 (sin normalizar ni ordenar). */
export async function loadOpenF1Session(startUtc: string, onStep: (s: string) => void): Promise<RawMessage[]> {
  onStep("buscando la sesión en OpenF1");
  const session = await findSession(startUtc);
  const key = session.session_key;

  onStep("bajando tiempos de OpenF1");
  const q = { session_key: key };
  const [meetings, drivers, laps, intervals, position, stints, pit, raceControl, weather, results] = await Promise.all([
    get("meetings", { meeting_key: session.meeting_key }),
    get("drivers", q),
    get("laps", q),
    get("intervals", q),
    get("position", q),
    get("stints", q),
    get("pit", q),
    get("race_control", q),
    get("weather", q),
    get("session_result", q).catch(() => []),
  ]);
  if (!drivers.length || !laps.length) {
    throw new Error("OpenF1 todavía no tiene datos de esta sesión (el histórico gratuito se libera unos 30 minutos después del final).");
  }

  // Posiciones solo durante la actividad en pista: es el endpoint pesado (~3 MB por auto).
  let first = Infinity;
  let last = -Infinity;
  for (const r of laps) {
    const t = Date.parse(r.date_start);
    if (t < first) first = t;
    if (t > last) last = t;
  }
  for (const r of raceControl) last = Math.max(last, Date.parse(r.date));
  const from = new Date(first - 3 * 60_000).toISOString();
  const to = new Date(last + 3 * 60_000).toISOString();
  let done = 0;
  const location: number[] = [];
  const queue = [...drivers];
  await Promise.all(
    Array.from({ length: 3 }, async () => {
      for (let drv = queue.shift(); drv; drv = queue.shift()) {
        const rows = await get("location", { session_key: key, driver_number: drv.driver_number, "date>": from, "date<": to });
        // Se guardan aplanadas: son ~25.000 filas por auto y no hace falta retener los objetos.
        for (const r of rows) location.push(r.driver_number, Date.parse(r.date), r.x, r.y);
        onStep(`bajando posiciones de OpenF1 (${++done}/${drivers.length})`);
      }
    }),
  );

  onStep("procesando");
  return adaptOpenF1({ session, meeting: meetings[0], drivers, laps, intervals, position, stints, pit, raceControl, weather, results, location });
}

/** Calendario del año según OpenF1, en el mismo formato que el del archivo de F1 (sin `path`). */
export async function listOpenF1Meetings(year: number): Promise<MeetingEntry[]> {
  const [meetings, sessions] = await Promise.all([get("meetings", { year }), get("sessions", { year })]);
  const iso = (d: string) => new Date(d).toISOString();
  return meetings
    .sort((a, b) => Date.parse(a.date_start) - Date.parse(b.date_start))
    .map((m) => ({
      key: m.meeting_key,
      name: m.meeting_name,
      location: m.location,
      country: m.country_name,
      sessions: sessions
        .filter((s) => s.meeting_key === m.meeting_key && !s.is_cancelled)
        .sort((a, b) => Date.parse(a.date_start) - Date.parse(b.date_start))
        .map((s) => ({ key: s.session_key, name: s.session_name, type: s.session_type, startUtc: iso(s.date_start), endUtc: iso(s.date_end), path: null, data: null })),
    }))
    .filter((m) => m.sessions.length);
}
