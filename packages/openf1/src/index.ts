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

/** Error de HTTP con su código, para decidir si vale reintentar o partir el pedido. */
class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
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
    // 429 (límite de pedidos) y 5xx son pasajeros: se reintenta con espera creciente.
    if ((res.status === 429 || res.status >= 500) && attempt < 3) {
      await sleep(5000 * (attempt + 1));
      continue;
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new HttpError(res.status, `OpenF1 respondió HTTP ${res.status} en ${endpoint}${detail ? `: ${detail.slice(0, 160)}` : ""}`);
    }
    const body = await res.json();
    return Array.isArray(body) ? body : [];
  }
}

/**
 * Pide un endpoint pesado (`location`, `car_data`) para un rango de fechas.
 * A veces OpenF1 rechaza con 422 ("demasiados datos de una vez") un pedido que otro día acepta:
 * se reintenta una vez y, si insiste, se parte el rango en dos mitades hasta que entre.
 */
async function getRange(endpoint: string, params: Record<string, string | number>, from: number, to: number): Promise<Row[]> {
  const iso = (t: number) => new Date(t).toISOString();
  const one = (a: number, b: number) => get(endpoint, { ...params, "date>": iso(a), "date<": iso(b) });
  const walk = async (a: number, b: number, retried: boolean): Promise<Row[]> => {
    try {
      return await one(a, b);
    } catch (err) {
      if (!(err instanceof HttpError) || err.status !== 422) throw err;
      if (!retried) {
        await sleep(3000);
        return walk(a, b, true);
      }
      if (b - a < 5 * 60_000) throw err;
      const mid = Math.round((a + b) / 2);
      return [...(await walk(a, mid, true)), ...(await walk(mid, b, true))];
    }
  };
  return walk(from, to, false);
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
  /** Telemetría aplanada de a siete: nº de auto, epoch ms, velocidad, rpm, marcha, acelerador, freno. Vacía si no se pidió. */
  car: number[];
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

  // Clasificación: las partes (Q1/Q2/Q3) salen de Race Control. Cada luz verde después de una
  // bandera a cuadros abre la siguiente. Pasan los primeros N: 22 → 16 → 10 (20 → 15 → 10).
  const isQuali = /qualifying/i.test(d.session.session_name ?? "");
  const rcSorted = [...d.raceControl].sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
  const partStarts: number[] = [];
  if (isQuali) {
    let chequered = false;
    for (const r of rcSorted) {
      if (r.flag === "CHEQUERED") chequered = true;
      else if (String(r.message ?? "").toUpperCase().includes("GREEN LIGHT") && (!partStarts.length || chequered)) {
        partStarts.push(at(r.date));
        chequered = false;
      }
    }
    const n = d.drivers.length;
    push("TimingData", 0, { SessionPart: 1, NoEntries: [n, n - Math.ceil((n - 10) / 2), 10] });
  }
  const noEntries = [d.drivers.length, d.drivers.length - Math.ceil((d.drivers.length - 10) / 2), 10];
  const positionAt = (num: number, ts: number) => {
    let p: number | null = null;
    for (const r of d.position) {
      if (r.driver_number !== num) continue;
      if (at(r.date) > ts) break;
      p = r.position;
    }
    return p;
  };

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
  type Ev = { ts: number; num: number; lap: number } & ({ kind: "sector"; i: number; v: number } | { kind: "lap"; v: number | null } | { kind: "part"; part: number });
  const events: Ev[] = [];
  partStarts.slice(1).forEach((ts, i) => events.push({ ts, num: 0, lap: 0, kind: "part", part: i + 2 }));
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
      // Mini-sectores: al empezar la vuelta vuelven a cero y se completan repartidos a lo largo de cada sector
      // (OpenF1 da el estado final de cada uno, no cuándo se cruzó; el reparto parejo es una aproximación).
      const segs = [r.segments_sector_1, r.segments_sector_2, r.segments_sector_3];
      line(start, num, {
        Sectors: Object.fromEntries(segs.flatMap((sg, i) => (Array.isArray(sg) ? [[i, { Segments: sg.map(() => ({ Status: 0 })) }]] : []))),
      });
      let t = start;
      [r.duration_sector_1, r.duration_sector_2, r.duration_sector_3].forEach((v, i) => {
        if (typeof v !== "number") return;
        const sg = segs[i];
        if (Array.isArray(sg)) {
          sg.forEach((status: unknown, j: number) => {
            if (typeof status !== "number") return;
            line(Math.round(t + (v * 1000 * (j + 1)) / sg.length), num, { Sectors: { [i]: { Segments: { [j]: { Status: status } } } } });
          });
        }
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
  const knockedOut = new Set<number>();
  for (const e of events) {
    if (e.kind === "part") {
      // Arranca Q2 o Q3: quedan afuera los que están por debajo del corte y, para el resto, los tiempos vuelven a cero.
      const through = noEntries[e.part - 1];
      push("TimingData", e.ts, { SessionPart: e.part });
      for (const r of d.drivers) {
        const num = r.driver_number;
        if (knockedOut.has(num)) continue;
        const pos = positionAt(num, e.ts);
        if (pos !== null && pos > through) {
          knockedOut.add(num);
          line(e.ts, num, { KnockedOut: true });
        } else {
          line(e.ts, num, { BestLapTime: { Value: "" }, LastLapTime: { ...blank }, Sectors: [{ ...blank }, { ...blank }, { ...blank }] });
        }
      }
      bestLap.clear();
      fastest = Infinity;
      continue;
    }
    if (knockedOut.has(e.num)) continue;
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
    // `date` es la salida de boxes (verificado contra el feed: coincide con `InPit: false`); la entrada es `date` menos el tiempo en la calle.
    const out = at(r.date);
    line(Math.max(0, out - (r.lane_duration ?? r.pit_duration ?? 22) * 1000), r.driver_number, { InPit: true, NumberOfPitStops: n });
    line(out, r.driver_number, { InPit: false });
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
  // En orden cronológico: los deltas van por índice y uno fuera de orden dejaría huecos en la lista.
  rcSorted.forEach((r, i) => {
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

  // Posiciones y telemetría: una muestra por auto cada ~260 ms; se agrupan en mensajes de 250 ms.
  // Cada entrada lleva al final cuánto se corre su muestra respecto del mensaje (negativo), para no perder
  // la precisión de tiempo que necesita la telemetría.
  const buckets = new Map<number, Row>();
  for (let i = 0; i < d.location.length; i += 4) {
    const ts = d.location[i + 1] - t0;
    const b = Math.floor(ts / 250);
    if (!buckets.has(b)) buckets.set(b, {});
    buckets.get(b)![d.location[i]] = [d.location[i + 2], d.location[i + 3], 1, Math.round(ts - (b + 1) * 250)];
  }
  for (const [b, entries] of buckets) push("Position", (b + 1) * 250, entries);

  const carBuckets = new Map<number, Row>();
  for (let i = 0; i < d.car.length; i += 7) {
    const ts = d.car[i + 1] - t0;
    const b = Math.floor(ts / 250);
    if (!carBuckets.has(b)) carBuckets.set(b, {});
    const [speed, rpm, gear, throttle, brake] = d.car.slice(i + 2, i + 7);
    carBuckets.get(b)![d.car[i]] = [speed, rpm, gear, Math.min(throttle, 100), brake > 0 ? 1 : 0, Math.round(ts - (b + 1) * 250)];
  }
  for (const [b, entries] of carBuckets) push("CarData", (b + 1) * 250, entries);

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

/**
 * Baja la sesión entera de OpenF1 y la devuelve como mensajes del feed de F1 (sin normalizar ni ordenar).
 * `withCar` suma la telemetría (`car_data`): otros 20 pedidos, así que solo se pide cuando hace falta.
 */
export async function loadOpenF1Session(startUtc: string, onStep: (s: string) => void, opts: { withCar?: boolean } = {}): Promise<RawMessage[]> {
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
  const from = first - 3 * 60_000;
  const to = last + 3 * 60_000;
  let done = 0;
  const location: number[] = [];
  const queue = [...drivers];
  await Promise.all(
    Array.from({ length: 3 }, async () => {
      for (let drv = queue.shift(); drv; drv = queue.shift()) {
        const rows = await getRange("location", { session_key: key, driver_number: drv.driver_number }, from, to);
        // Se guardan aplanadas: son ~25.000 filas por auto y no hace falta retener los objetos.
        for (const r of rows) location.push(r.driver_number, Date.parse(r.date), r.x, r.y);
        onStep(`bajando posiciones de OpenF1 (${++done}/${drivers.length})`);
      }
    }),
  );

  const car: number[] = [];
  if (opts.withCar) {
    done = 0;
    const carQueue = [...drivers];
    await Promise.all(
      Array.from({ length: 3 }, async () => {
        for (let drv = carQueue.shift(); drv; drv = carQueue.shift()) {
          const rows = await getRange("car_data", { session_key: key, driver_number: drv.driver_number }, from, to);
          for (const r of rows) car.push(r.driver_number, Date.parse(r.date), r.speed ?? 0, r.rpm ?? 0, r.n_gear ?? 0, r.throttle ?? 0, r.brake ?? 0);
          onStep(`bajando telemetría de OpenF1 (${++done}/${drivers.length})`);
        }
      }),
    );
  }

  onStep("procesando");
  return adaptOpenF1({ session, meeting: meetings[0], drivers, laps, intervals, position, stints, pit, raceControl, weather, results, location, car });
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
