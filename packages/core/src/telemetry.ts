import { gunzipSync, gzipSync, strFromU8, strToU8 } from "fflate";
import { StateEngine } from "./engine";
import { parseLapTime } from "./parse";
import type { RawMessage, TrackOutline } from "./types";

type XY = [number, number];
type Obj = Record<string, any>;

/** Versión del formato de telemetría. Va en el nombre del archivo publicado. */
export const TELEMETRY_VERSION = 2;
/** Puntos por vuelta: la vuelta se remuestrea en este largo de grilla, uniforme en distancia (~20 m en Bakú). */
export const GRID = 300;

export type LapKind = "flying" | "out" | "in" | "both" | "start";

/** Una vuelta de un piloto: tiempo y canales en cada punto de la grilla, de la meta a la meta. */
export interface TelemetryLap {
  /** nº de auto */
  d: string;
  /** nº de vuelta */
  n: number;
  /** ms de stream en que cruza la meta y abre la vuelta */
  s: number;
  /** ms de stream en que la cierra */
  e: number;
  /** tiempo oficial de vuelta, ms */
  ms: number;
  /** flying = vuelta lanzada; out/in = salida o entrada de boxes; both = las dos; start = vuelta 1 de una carrera */
  kind: LapKind;
  /** parte de la clasificación (1 a 3), si corresponde */
  part: number | null;
  tyre: string | null;
  age: number | null;
  /** ms desde la meta hasta cada punto de la grilla */
  t: number[];
  /** velocidad, km/h */
  v: number[];
  /** acelerador, 0 a 100 */
  th: number[];
  /** freno, 0 o 1 */
  br: number[];
  /** marcha */
  g: number[];
  /** rpm */
  r: number[];
}

export interface SessionTelemetry {
  v: number;
  /** largo del trazado, m */
  length: number;
  grid: number;
  /** fracción del trazado donde empiezan el sector 2 y el 3 */
  marks: [number, number] | null;
  laps: TelemetryLap[];
}

// --- geometría del trazado ---

interface OutlineIndex {
  pts: XY[];
  /** distancia acumulada hasta cada punto, en unidades del feed (1/10 m) */
  cum: number[];
  total: number;
}

export function indexOutline(points: XY[]): OutlineIndex {
  const cum = [0];
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
    cum.push(total);
  }
  const last = points[points.length - 1];
  total += Math.hypot(points[0][0] - last[0], points[0][1] - last[1]);
  return { pts: points, cum, total };
}

/**
 * Proyecta un punto sobre el trazado y devuelve la fracción recorrida (0 en la meta).
 * Con `hint` (segmento anterior) solo mira los vecinos: sigue al auto sin saltar a un tramo paralelo,
 * como la recta de boxes o las curvas que se cruzan cerca.
 */
export function projectOnOutline(
  ix: OutlineIndex,
  x: number,
  y: number,
  hint: number | null = null,
): { f: number; i: number; d: number } | null {
  const n = ix.pts.length;
  const scan = (from: number, count: number) => {
    let best = { f: 0, i: 0, d: Infinity };
    for (let k = 0; k < count; k++) {
      const i = (((from + k) % n) + n) % n;
      const a = ix.pts[i];
      const b = ix.pts[(i + 1) % n];
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const len2 = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / len2));
      const d = Math.hypot(x - (a[0] + t * dx), y - (a[1] + t * dy));
      if (d < best.d) best = { f: (ix.cum[i] + t * Math.sqrt(len2)) / ix.total, i, d };
    }
    return best;
  };
  if (hint !== null) {
    const near = scan(hint - 25, 51);
    if (near.d < 1500) return near;
  }
  const all = scan(0, n);
  return all.d < 3000 ? all : null;
}

// --- muestras ---

interface PosSeries {
  u: number[];
  x: number[];
  y: number[];
}
interface CarSeries {
  u: number[];
  v: number[];
  r: number[];
  g: number[];
  th: number[];
  br: number[];
}

function sortByU<T extends { u: number[] }>(s: T): T {
  const u = s.u;
  let sorted = true;
  for (let i = 1; i < u.length; i++) if (u[i] < u[i - 1]) sorted = false;
  if (sorted) return s;
  const order = u.map((_, i) => i).sort((a, b) => u[a] - u[b]);
  for (const key of Object.keys(s) as (keyof T)[]) (s as any)[key] = order.map((i) => (s as any)[key][i]);
  return s;
}

/** Primer índice con `arr[i] >= v`. */
function lowerBound(arr: number[], v: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function sampleCar(c: CarSeries, tu: number): { v: number; r: number; g: number; th: number; br: number } {
  const k = lowerBound(c.u, tu);
  const k0 = Math.max(0, k - 1);
  const k1 = Math.min(c.u.length - 1, k);
  const span = c.u[k1] - c.u[k0];
  const w = span > 0 && span < 1500 ? (tu - c.u[k0]) / span : tu - c.u[k0] < c.u[k1] - tu ? 0 : 1;
  const lin = (a: number[]) => a[k0] + (a[k1] - a[k0]) * w;
  const near = w < 0.5 ? k0 : k1;
  return { v: Math.round(lin(c.v)), r: Math.round(lin(c.r)), th: Math.round(lin(c.th)), g: c.g[near], br: c.br[near] };
}

// --- armado de las vueltas ---

interface LapEvent {
  lap: number;
  /** ts de stream del mensaje que cierra la vuelta */
  ts: number;
  /** desfase stream → utc vigente en ese momento */
  offset: number;
  ms: number | null;
  inPit: boolean;
  pitOut: boolean;
  tyre: string | null;
  age: number | null;
  part: number | null;
}

interface Trace {
  startUtc: number;
  ms: number;
  t: number[];
  v: number[];
  th: number[];
  br: number[];
  g: number[];
  r: number[];
}

/** Remuestrea una vuelta en la grilla de distancia, alineando las posiciones con el trazado. */
function traceLap(
  ix: OutlineIndex,
  pos: PosSeries,
  car: CarSeries | null,
  startUtc: number,
  endUtc: number,
  ms: number | null,
  grid: number,
): Trace | string {
  const lo = lowerBound(pos.u, startUtc - 3000);
  const hi = lowerBound(pos.u, endUtc + 3000);
  if (hi - lo < 30) return `pocas posiciones (${hi - lo})`;

  const U: number[] = [];
  const F: number[] = [];
  let hint: number | null = null;
  let prev = 0;
  let wrap = 0;
  for (let k = lo; k < hi; k++) {
    const p = projectOnOutline(ix, pos.x[k], pos.y[k], hint);
    if (!p) continue;
    hint = p.i;
    if (U.length) {
      const d = p.f - prev;
      if (d < -0.5) wrap++;
      else if (d > 0.5) wrap--;
    }
    prev = p.f;
    U.push(pos.u[k]);
    F.push(p.f + wrap);
  }
  if (U.length < 30) return "no se pudo proyectar sobre el trazado";
  for (let i = 1; i < U.length; i++) if (U[i] - U[i - 1] > 4000) return "hueco de posiciones";

  // La fracción en el instante de salida tiene que caer sobre la meta (módulo vueltas enteras).
  const k0 = Math.max(1, lowerBound(U, startUtc));
  const w0 = (startUtc - U[k0 - 1]) / Math.max(1, U[k0] - U[k0 - 1]);
  const f0 = F[k0 - 1] + (F[k0] - F[k0 - 1]) * Math.max(0, Math.min(1, w0));
  const base = Math.round(f0);
  if (Math.abs(f0 - base) > 0.1) return `no arranca en la meta (${f0.toFixed(2)})`;
  for (let i = 0; i < F.length; i++) F[i] -= base;
  for (let i = 1; i < F.length; i++) if (F[i] < F[i - 1]) F[i] = F[i - 1];
  if (F[0] > 0.002 || F[F.length - 1] < 0.998) return `no cubre la vuelta (${F[0].toFixed(3)} a ${F[F.length - 1].toFixed(3)})`;

  const tAt = (u: number) => {
    const k = lowerBound(F, u);
    if (k <= 0) return U[0];
    if (k >= F.length) return U[U.length - 1];
    const df = F[k] - F[k - 1];
    return df > 0 ? U[k - 1] + ((u - F[k - 1]) / df) * (U[k] - U[k - 1]) : U[k];
  };
  const t0 = tAt(0);
  const span = tAt(1) - t0;
  if (!(span > 20_000 && span < 400_000)) return `duración rara (${Math.round(span)} ms)`;
  let scale = 1;
  if (ms) {
    scale = ms / span;
    if (Math.abs(scale - 1) > 0.03) return `tiempo oficial distinto del medido (${scale.toFixed(3)})`; // p. ej. la vuelta 1 de una carrera, que cuenta desde parado
  }

  const out: Trace = { startUtc: t0, ms: ms ?? Math.round(span), t: [], v: [], th: [], br: [], g: [], r: [] };
  // Las posiciones llegan cada ~250 ms y con algo de ruido: el tiempo en cada punto sale con saltos de ±0,1 s que
  // harían ilegible la diferencia entre dos vueltas. Se suaviza con una ventana simétrica que se achica hacia los
  // extremos, así la meta (0) y el final (tiempo oficial) quedan exactos.
  const abs = Array.from({ length: grid }, (_, i) => tAt(i / (grid - 1)));
  const raw = abs.map((ta) => (ta - t0) * scale);
  const SMOOTH = 4;
  let run = 0;
  const smooth = raw.map((_, i) => {
    const k = Math.min(SMOOTH, i, grid - 1 - i);
    let sum = 0;
    for (let j = i - k; j <= i + k; j++) sum += raw[j];
    run = Math.max(run, sum / (2 * k + 1));
    return run;
  });
  for (let i = 0; i < grid; i++) {
    const ta = abs[i];
    out.t.push(Math.round(smooth[i]));
    const c = car?.u.length ? sampleCar(car, ta) : { v: 0, r: 0, g: 0, th: 0, br: 0 };
    out.v.push(c.v);
    out.th.push(c.th);
    out.br.push(c.br);
    out.g.push(c.g);
    out.r.push(c.r);
  }
  return out;
}

/**
 * Arma la telemetría de una sesión a partir de los mensajes ya preparados (`prepareMessages`):
 * cada vuelta cerrada de cada piloto, con tiempo y canales a lo largo del trazado.
 * Funciona igual con el archivo de F1 y con OpenF1, que traducen al mismo formato de mensajes.
 */
export function buildTelemetry(
  messages: RawMessage[],
  outline: TrackOutline | null,
  opts: {
    grid?: number /** avisa de cada vuelta que se descarta y por qué */;
    onSkip?: (driver: string, lap: number, reason: string) => void;
  } = {},
): SessionTelemetry | null {
  if (!outline || outline.points.length < 50) return null;
  const grid = opts.grid ?? GRID;
  const ix = indexOutline(outline.points);

  const engine = new StateEngine({ gapSampleEvery: Infinity });
  engine.outline = outline;

  const pos = new Map<string, PosSeries>();
  const car = new Map<string, CarSeries>();
  const events = new Map<string, LapEvent[]>();
  const flagIn = new Set<string>();
  const flagOut = new Set<string>();
  let offset = 0;
  let isRace = false;

  for (const m of messages) {
    if (m.topic === "Position") {
      const base = m.utc ?? m.ts + offset;
      for (const num in m.data as Obj) {
        if (+num >= 240) continue; // autos de seguridad
        const e = (m.data as Obj)[num];
        const [x, y, on, dt] = Array.isArray(e) ? [e[0], e[1], !!e[2], e[3] ?? 0] : [e.X, e.Y, e.Status === "OnTrack", 0];
        if (!on || (x === 0 && y === 0)) continue;
        let s = pos.get(num);
        if (!s) {
          s = { u: [], x: [], y: [] };
          pos.set(num, s);
        }
        s.u.push(base + dt);
        s.x.push(x);
        s.y.push(y);
      }
      continue;
    }
    if (m.topic === "CarData") {
      const base = m.utc ?? m.ts + offset;
      for (const num in m.data as Obj) {
        if (+num >= 240) continue;
        const e = (m.data as Obj)[num] as number[];
        let s = car.get(num);
        if (!s) {
          s = { u: [], v: [], r: [], g: [], th: [], br: [] };
          car.set(num, s);
        }
        s.u.push(base + (e[5] ?? 0));
        s.v.push(e[0]);
        s.r.push(e[1]);
        s.g.push(e[2]);
        s.th.push(e[3]);
        s.br.push(e[4]);
      }
      continue;
    }
    if (m.topic === "Heartbeat") {
      const utc = Date.parse((m.data as Obj)?.Utc);
      if (Number.isFinite(utc)) offset = utc - m.ts;
    } else if (m.topic === "LapCount") isRace = true;

    // Una vuelta se cierra cuando el delta trae `NumberOfLaps`; `LastLapTime` viene en el mismo delta.
    const closing: { num: string; lap: number; ms: number | null }[] = [];
    if (m.topic === "TimingData") {
      const lines = (m.data as Obj)?.Lines as Obj | undefined;
      for (const num in lines ?? {}) {
        const l = lines![num];
        if (!l || typeof l !== "object") continue;
        if (l.PitOut === true) flagOut.add(num);
        if (l.InPit === true) flagIn.add(num);
        if (typeof l.NumberOfLaps === "number" && l.NumberOfLaps > 0) {
          const sec = parseLapTime(l.LastLapTime?.Value);
          closing.push({ num, lap: l.NumberOfLaps, ms: sec ? Math.round(sec * 1000) : null });
        }
      }
    }
    engine.apply(m);
    for (const c of closing) {
      const info = engine.peek(c.num);
      let list = events.get(c.num);
      if (!list) {
        list = [];
        events.set(c.num, list);
      }
      list.push({
        lap: c.lap,
        ts: m.ts,
        offset,
        ms: c.ms,
        inPit: flagIn.delete(c.num),
        pitOut: flagOut.delete(c.num),
        tyre: info.tyre?.compound ?? null,
        age: info.tyre?.age ?? null,
        part: info.part,
      });
    }
  }
  for (const s of pos.values()) sortByU(s);
  for (const s of car.values()) sortByU(s);

  const laps: TelemetryLap[] = [];
  for (const [num, list] of events) {
    const p = pos.get(num);
    if (!p) continue;
    const c = car.get(num) ?? null;
    // Una por nº de vuelta (si el feed la repite, vale la última), en orden.
    const byLap = new Map<number, LapEvent>();
    for (const ev of list) byLap.set(ev.lap, ev);
    let prevEnd: number | null = null;
    for (const ev of [...byLap.values()].sort((a, b) => a.lap - b.lap)) {
      const endUtc = ev.ts + ev.offset;
      const startUtc = ev.ms ? endUtc - ev.ms : prevEnd;
      prevEnd = endUtc;
      if (startUtc === null) continue;
      const tr = traceLap(ix, p, c, startUtc, endUtc, ev.ms, grid);
      if (typeof tr === "string") {
        opts.onSkip?.(num, ev.lap, tr);
        continue;
      }
      const s = Math.round(tr.startUtc - ev.offset);
      laps.push({
        d: num,
        n: ev.lap,
        s,
        e: s + tr.ms,
        ms: tr.ms,
        kind: ev.inPit && ev.pitOut ? "both" : ev.inPit ? "in" : ev.pitOut ? "out" : ev.lap === 1 && isRace ? "start" : "flying",
        part: ev.part,
        tyre: ev.tyre,
        age: ev.age,
        t: tr.t,
        v: tr.v,
        th: tr.th,
        br: tr.br,
        g: tr.g,
        r: tr.r,
      });
    }
  }
  if (!laps.length) return null;
  laps.sort((a, b) => +a.d - +b.d || a.n - b.n);

  let marks: [number, number] | null = null;
  const m2 = outline.marks?.s2;
  const m3 = outline.marks?.s3;
  if (m2 && m3) {
    const a = projectOnOutline(ix, m2[0], m2[1]);
    const b = projectOnOutline(ix, m3[0], m3[1]);
    if (a && b && a.f > 0 && b.f > a.f) marks = [a.f, b.f];
  }
  return { v: TELEMETRY_VERSION, length: Math.round(ix.total / 10), grid, marks, laps };
}

// --- archivo ---

const delta = (a: number[]) => a.map((x, i) => (i ? x - a[i - 1] : x));
const undelta = (a: number[]) => {
  let acc = 0;
  return a.map((x) => (acc += x));
};

/** Empaqueta la telemetría en un gzip. Los canales van como diferencias entre puntos contiguos, que comprimen mucho mejor. */
export function packTelemetry(t: SessionTelemetry): Uint8Array {
  const laps = t.laps.map((l) => [
    l.d,
    l.n,
    l.s,
    l.e,
    l.ms,
    l.kind,
    l.part,
    l.tyre,
    l.age,
    delta(l.t),
    delta(l.v),
    delta(l.th),
    delta(l.br),
    delta(l.g),
    delta(l.r.map((r) => Math.round(r / 10))),
  ]);
  return gzipSync(strToU8(JSON.stringify({ v: t.v, length: t.length, grid: t.grid, marks: t.marks, laps })), { level: 9 });
}

export function unpackTelemetry(bytes: Uint8Array): SessionTelemetry {
  const d = JSON.parse(strFromU8(gunzipSync(bytes)));
  if (d.v !== TELEMETRY_VERSION) throw new Error(`formato de telemetría desconocido (v${d.v})`);
  const laps: TelemetryLap[] = d.laps.map((l: any[]) => ({
    d: l[0],
    n: l[1],
    s: l[2],
    e: l[3],
    ms: l[4],
    kind: l[5],
    part: l[6],
    tyre: l[7],
    age: l[8],
    t: undelta(l[9]),
    v: undelta(l[10]),
    th: undelta(l[11]),
    br: undelta(l[12]),
    g: undelta(l[13]),
    r: undelta(l[14]).map((r) => r * 10),
  }));
  return { v: d.v, length: d.length, grid: d.grid, marks: d.marks, laps };
}

// --- consultas para la interfaz ---

/** Distancia desde la meta, en metros, de cada punto de la grilla. */
export function distanceAxis(t: SessionTelemetry): number[] {
  return Array.from({ length: t.grid }, (_, i) => (i / (t.grid - 1)) * t.length);
}

/** Diferencia de tiempo en cada punto, en segundos: positivo = `a` va más lento que `ref`. */
export function deltaSeries(a: TelemetryLap, ref: TelemetryLap): number[] {
  return a.t.map((x, i) => (x - ref.t[i]) / 1000);
}

/** Tiempo en el que la vuelta pasa por la fracción `f` del trazado, ms. */
export function timeAtFraction(lap: TelemetryLap, f: number): number {
  const x = Math.max(0, Math.min(1, f)) * (lap.t.length - 1);
  const i = Math.min(lap.t.length - 2, Math.floor(x));
  return lap.t[i] + (lap.t[i + 1] - lap.t[i]) * (x - i);
}

/** Tiempos de S1, S2 y S3 en ms (derivados de la traza, así que suman el tiempo de vuelta). */
export function sectorTimes(lap: TelemetryLap, marks: [number, number] | null): [number, number, number] | null {
  if (!marks) return null;
  const a = timeAtFraction(lap, marks[0]);
  const b = timeAtFraction(lap, marks[1]);
  return [a, b - a, lap.ms - b];
}

/** La más rápida de las vueltas lanzadas. */
export function bestLap(laps: TelemetryLap[]): TelemetryLap | null {
  let best: TelemetryLap | null = null;
  for (const l of laps) if (l.kind === "flying" && (!best || l.ms < best.ms)) best = l;
  return best;
}

/** Vueltas ya cerradas en el instante `now` (ms de stream). */
export function completedLaps(t: SessionTelemetry, now: number): TelemetryLap[] {
  return t.laps.filter((l) => l.e <= now);
}

/** La vuelta que `driver` tiene en curso en `now`, con cuántos puntos de la grilla ya recorrió. */
export function currentLap(t: SessionTelemetry, driver: string, now: number): { lap: TelemetryLap; upto: number } | null {
  const lap = t.laps.find((l) => l.d === driver && l.s <= now && now < l.e);
  if (!lap) return null;
  const elapsed = now - lap.s;
  let upto = 0;
  while (upto + 1 < lap.t.length && lap.t[upto + 1] <= elapsed) upto++;
  return { lap, upto };
}

// --- análisis sobre la telemetría ---

export interface DominanceSegment {
  /** fracción del trazado donde empieza y termina el tramo */
  from: number;
  to: number;
  /** quién tardó menos; null si la diferencia es menor al empate */
  winner: string | null;
  /** cuánto más rápido que el segundo, ms */
  marginMs: number;
  /** tiempo de cada piloto en el tramo, ms */
  times: Record<string, number>;
}

/**
 * Quién fue más rápido en cada tramo del circuito, comparando una vuelta por piloto (en general, la mejor hasta el
 * momento). La vuelta se alinea por posición y se escala al tiempo oficial, así que la precisión por tramo es
 * aproximada: diferencias de pocas centésimas son ruido, y por eso hay un umbral de empate.
 */
export function dominance(laps: Record<string, TelemetryLap>, segments: number, tieMs: number): DominanceSegment[] {
  const drivers = Object.keys(laps);
  if (drivers.length < 2) return [];
  return Array.from({ length: segments }, (_, i) => {
    const from = i / segments;
    const to = (i + 1) / segments;
    const times: Record<string, number> = {};
    for (const d of drivers) times[d] = timeAtFraction(laps[d], to) - timeAtFraction(laps[d], from);
    const ranked = Object.entries(times).sort((a, b) => a[1] - b[1]);
    const marginMs = ranked[1][1] - ranked[0][1];
    return { from, to, winner: marginMs < tieMs ? null : ranked[0][0], marginMs, times };
  });
}

export interface TopSpeed {
  driver: string;
  kmh: number;
  lap: number;
  /** a qué distancia de la meta, m */
  atM: number;
}

/**
 * La velocidad máxima de cada piloto según la telemetría (unas 4 muestras por segundo: puede quedar unos km/h por
 * debajo del valor de la trampa de velocidad). Ordenado de mayor a menor.
 */
export function topSpeeds(laps: TelemetryLap[], length: number): TopSpeed[] {
  const best = new Map<string, TopSpeed>();
  for (const l of laps) {
    let max = 0;
    let at = 0;
    for (let i = 0; i < l.v.length; i++) {
      if (l.v[i] > max) {
        max = l.v[i];
        at = i;
      }
    }
    const cur = best.get(l.d);
    if (!cur || max > cur.kmh) best.set(l.d, { driver: l.d, kmh: max, lap: l.n, atM: Math.round((at / (l.v.length - 1)) * length) });
  }
  return [...best.values()].sort((a, b) => b.kmh - a.kmh);
}
