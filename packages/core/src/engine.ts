import { asList, deepMerge } from "./merge";
import { parseClock, parseGap, toNumber } from "./parse";
import type {
  DriverRow,
  GapSample,
  LapState,
  RaceControlMessage,
  RawMessage,
  SessionMeta,
  Snapshot,
  TimedValue,
  TopicHealth,
  TrackOutline,
  Tyre,
  Weather,
} from "./types";

type Obj = Record<string, any>;
type XY = [number, number];

interface Checkpoint {
  ts: number;
  seq: number;
  histLen: number;
  /** estado serializado */
  state: string;
}

export interface EngineOptions {
  /** ms de sesión entre checkpoints; 0 = sin checkpoints (live). */
  checkpointEvery?: number;
  /** ms de sesión entre muestras del gráfico de gaps. */
  gapSampleEvery?: number;
  /** Los ts son epoch ms (live) en vez de ms desde el inicio del stream. */
  epochTs?: boolean;
}

const OUTLINE_MIN_POINTS = 100;
const OUTLINE_MAX_POINTS = 3000;
const PIT_MIN_POINTS = 20;
const PIT_MAX_POINTS = 800;
/** Entradas de `Position` que no son pilotos: 241 es el Safety Car; 242 y 243, UNVERIFIED (auto médico / segundo SC). */
const SAFETY_CARS = ["241", "242", "243"];

/**
 * Estado de la sesión. Aplica los deltas del feed con deep-merge sobre el JSON crudo de cada topic
 * y arma un `Snapshot` tipado para el front. Es puro: no hace I/O ni mira el reloj.
 */
export class StateEngine {
  /** ts del último mensaje aplicado */
  time = 0;
  /** cantidad de mensajes aplicados */
  seq = 0;
  /** Muestras de gaps, solo se agrega al final (un rewind la trunca). */
  history: GapSample[] = [];
  outline: TrackOutline | null = null;

  private raw: Record<string, any> = {};
  private positions: Record<string, [number, number, boolean]> = {};
  private topics: Record<string, TopicHealth> = {};
  private utcOffset: number | null = null;
  private clockTs = 0;
  private lastSampleT = -Infinity;
  private checkpoints: Checkpoint[] = [];
  private lapBufs = new Map<string, { pts: XY[]; dirty: boolean; s2?: number; s3?: number }>();
  private pitBufs = new Map<string, XY[]>();
  private pitLane: XY[] | null = null;
  private readonly checkpointEvery: number;
  private readonly gapSampleEvery: number;
  private readonly epochTs: boolean;

  constructor(opts: EngineOptions = {}) {
    this.checkpointEvery = opts.checkpointEvery ?? 0;
    this.gapSampleEvery = opts.gapSampleEvery ?? 5000;
    this.epochTs = opts.epochTs ?? false;
    if (this.epochTs) this.utcOffset = 0;
  }

  apply(msg: RawMessage): void {
    if (this.checkpointEvery > 0) this.maybeCheckpoint(msg.ts);
    this.seq++;
    if (msg.ts > this.time) this.time = msg.ts;
    const h = (this.topics[msg.topic] ??= { count: 0, lastTs: 0 });
    h.count++;
    h.lastTs = msg.ts;

    switch (msg.topic) {
      case "Position":
        this.applyPosition(msg.data as Obj);
        return;
      case "Heartbeat": {
        const utc = Date.parse((msg.data as Obj)?.Utc);
        if (Number.isFinite(utc) && !this.epochTs) this.utcOffset = utc - msg.ts;
        return;
      }
      case "TimingData":
        if (!this.outline) this.trackLaps(msg.data as Obj);
        if (!this.pitLane && !this.outline?.pit) this.trackPit(msg.data as Obj);
        break;
    }
    this.raw[msg.topic] = deepMerge(this.raw[msg.topic], msg.data);

    if (msg.topic === "ExtrapolatedClock") {
      // En live el estado inicial puede traer un reloj viejo: vale su propio Utc, no la hora de llegada.
      const utc = this.epochTs ? Date.parse(this.raw.ExtrapolatedClock?.Utc) : NaN;
      this.clockTs = Number.isFinite(utc) ? utc : msg.ts;
    }
    if (msg.topic === "TimingData" && this.time - this.lastSampleT >= this.gapSampleEvery) this.sampleGaps();
  }

  /**
   * Vuelve al checkpoint más cercano anterior a `ts` (o al estado vacío).
   * Devuelve cuántos mensajes quedan aplicados: la fuente tiene que seguir desde ahí.
   */
  rewindTo(ts: number): number {
    let cp: Checkpoint | undefined;
    for (const c of this.checkpoints) {
      if (c.ts > ts) break;
      cp = c;
    }
    this.lapBufs.clear();
    this.pitBufs.clear();
    if (!cp) {
      this.raw = {};
      this.positions = {};
      this.topics = {};
      this.utcOffset = null;
      this.clockTs = 0;
      this.lastSampleT = -Infinity;
      this.time = 0;
      this.seq = 0;
      this.history.length = 0;
      return 0;
    }
    const s = JSON.parse(cp.state);
    this.raw = s.raw;
    this.positions = s.positions;
    this.topics = s.topics;
    this.utcOffset = s.utcOffset;
    this.clockTs = s.clockTs;
    this.lastSampleT = s.lastSampleT ?? -Infinity;
    this.time = cp.ts;
    this.seq = cp.seq;
    this.history.length = cp.histLen;
    return cp.seq;
  }

  private maybeCheckpoint(nextTs: number): void {
    const last = this.checkpoints[this.checkpoints.length - 1];
    if (last && this.time <= last.ts) return; // zona ya recorrida
    if (nextTs - (last?.ts ?? 0) < this.checkpointEvery || this.seq === 0) return;
    this.checkpoints.push({
      ts: this.time,
      seq: this.seq,
      histLen: this.history.length,
      state: JSON.stringify({
        raw: this.raw,
        positions: this.positions,
        topics: this.topics,
        utcOffset: this.utcOffset,
        clockTs: this.clockTs,
        lastSampleT: Number.isFinite(this.lastSampleT) ? this.lastSampleT : null,
      }),
    });
  }

  // --- posiciones y trazado ---

  private applyPosition(entries: Obj): void {
    for (const num in entries) {
      // Forma del feed, `{Status, X, Y, Z}`, o la compacta de los datos publicados, `[x, y, enPista]`.
      const e = entries[num];
      const [x, y, onTrack]: [number, number, boolean] = Array.isArray(e) ? [e[0], e[1], !!e[2]] : [e.X, e.Y, e.Status === "OnTrack"];
      if (x === 0 && y === 0) {
        // Un auto que deja de transmitir (abandono en pista) pasa a 0,0: se conserva dónde quedó.
        const last = this.positions[num];
        if (last) last[2] = false;
        this.lapBufs.get(num) && (this.lapBufs.get(num)!.dirty = true);
        continue;
      }
      this.positions[num] = [x, y, onTrack];

      const pit = this.pitBufs.get(num);
      if (pit && pit.length < PIT_MAX_POINTS) {
        const p = pit[pit.length - 1];
        if (!p || p[0] !== x || p[1] !== y) pit.push([x, y]);
      }
      if (this.outline) continue;
      const buf = this.lapBufs.get(num) ?? { pts: [], dirty: false };
      if (!this.lapBufs.has(num)) this.lapBufs.set(num, buf);
      if (!onTrack) buf.dirty = true;
      else if (buf.pts.length >= OUTLINE_MAX_POINTS) buf.dirty = true;
      else {
        const p = buf.pts[buf.pts.length - 1];
        if (!p || p[0] !== x || p[1] !== y) buf.pts.push([x, y]);
      }
    }
    // Los autos de seguridad solo figuran mientras están desplegados.
    for (const id of SAFETY_CARS) if (!(id in entries)) delete this.positions[id];
  }

  /** La calle de boxes es el recorrido de un auto entre que entra (`InPit`) y sale. */
  private trackPit(delta: Obj): void {
    const lines = delta?.Lines;
    if (!lines) return;
    for (const num in lines) {
      const l = lines[num];
      if (typeof l.InPit !== "boolean") continue;
      const current = this.raw.TimingData?.Lines?.[num];
      if (l.InPit) {
        // Solo entradas desde la pista: quien arranca la sesión en el garage no recorre la calle entera.
        if (current?.InPit === false && (current.NumberOfLaps ?? 0) > 0) this.pitBufs.set(num, []);
        continue;
      }
      const pts = this.pitBufs.get(num);
      this.pitBufs.delete(num);
      if (!pts || pts.length < PIT_MIN_POINTS) continue;
      let length = 0;
      for (let i = 1; i < pts.length; i++) length += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      if (length < 2000) continue;
      this.pitLane = pts;
      this.pitBufs.clear();
      // Objeto nuevo: así quien ya mandó el trazado sabe que cambió.
      if (this.outline) this.outline = { ...this.outline, pit: pts };
      return;
    }
  }

  /** El trazado sale de la primera vuelta limpia (sin boxes, cerrada) de cualquier auto. */
  private trackLaps(delta: Obj): void {
    const lines = delta?.Lines;
    if (!lines) return;
    for (const num in lines) {
      const l = lines[num];
      const buf = this.lapBufs.get(num);
      if (!buf) continue;
      if (l.InPit === true || l.PitOut === true) buf.dirty = true;
      // Al marcar S1 y S2, el último punto guardado es el límite entre sectores.
      if (l.Sectors?.[0]?.Value) buf.s2 = buf.pts.length - 1;
      if (l.Sectors?.[1]?.Value) buf.s3 = buf.pts.length - 1;
      if (typeof l.NumberOfLaps !== "number") continue;
      if (!buf.dirty && buf.pts.length >= OUTLINE_MIN_POINTS) {
        const outline = toOutline(buf.pts);
        if (outline) {
          outline.marks = { s2: buf.pts[buf.s2 ?? -1], s3: buf.pts[buf.s3 ?? -1] };
          if (this.pitLane) outline.pit = this.pitLane;
          this.outline = outline;
          this.lapBufs.clear();
          return;
        }
      }
      const current = this.raw.TimingData?.Lines?.[num];
      this.lapBufs.set(num, { pts: [], dirty: !!(current?.InPit || l.InPit) });
    }
  }

  // --- gaps ---

  private sessionPart(): number | null {
    const p = this.raw.TimingData?.SessionPart;
    return typeof p === "number" && p > 0 ? p : null;
  }

  private gapText(line: Obj): { gap: string; interval: string; catching: boolean } {
    if (line.GapToLeader !== undefined || line.IntervalToPositionAhead !== undefined) {
      return {
        gap: line.GapToLeader ?? "",
        interval: line.IntervalToPositionAhead?.Value ?? "",
        catching: !!line.IntervalToPositionAhead?.Catching,
      };
    }
    // Clasificación: diferencias por parte (Q1/Q2/Q3) en `Stats`. Ojo: la clave es `TimeDifftoPositionAhead`.
    const part = this.sessionPart();
    const stat = part ? asList<Obj>(line.Stats)[part - 1] : undefined;
    if (stat) return { gap: stat.TimeDiffToFastest ?? "", interval: stat.TimeDifftoPositionAhead ?? "", catching: false };
    // Práctica
    return { gap: line.TimeDiffToFastest ?? "", interval: line.TimeDiffToPositionAhead ?? "", catching: false };
  }

  private gapSec(line: Obj, gap: string): number | null {
    const g = parseGap(gap);
    if (g !== null) return g;
    return String(line.Position) === "1" && !gap ? 0 : null;
  }

  private sampleGaps(): void {
    if (this.raw.SessionStatus?.Status !== "Started") return;
    const lines = this.raw.TimingData?.Lines as Obj | undefined;
    if (!lines) return;
    const gaps: Record<string, number | null> = {};
    for (const num in lines) {
      const l = lines[num];
      gaps[num] = l.Retired || l.Stopped ? null : this.gapSec(l, this.gapText(l).gap);
    }
    this.lastSampleT = this.time;
    this.history.push({ t: this.time, lap: this.raw.LapCount?.CurrentLap ?? null, gaps });
  }

  // --- snapshot ---

  snapshot(time: number = this.time): Snapshot {
    const r = this.raw;
    const lines = (r.TimingData?.Lines ?? {}) as Obj;
    const appLines = (r.TimingAppData?.Lines ?? {}) as Obj;
    const list = (r.DriverList ?? {}) as Obj;

    const drivers: DriverRow[] = [];
    for (const num in lines) {
      const l = lines[num];
      if (typeof l !== "object" || l === null) continue;
      const d = list[num] ?? {};
      const { gap, interval, catching } = this.gapText(l);
      const stints = asList<Obj>(appLines[num]?.Stints);
      const stint = stints[stints.length - 1];
      const tyre: Tyre | null = stint?.Compound
        ? { compound: stint.Compound, age: stint.TotalLaps ?? 0, isNew: String(stint.New) === "true" }
        : null;
      const pos = this.positions[num];
      drivers.push({
        num,
        tla: d.Tla ?? num,
        name: d.FullName ?? d.BroadcastName ?? num,
        team: d.TeamName ?? "",
        color: d.TeamColour ?? "888888",
        position: toNumber(l.Position) ?? toNumber(l.Line) ?? 99,
        gap,
        interval,
        gapSec: this.gapSec(l, gap),
        catching,
        lastLap: timed(l.LastLapTime),
        bestLap: l.BestLapTime?.Value ?? "",
        sectors: asList<Obj>(l.Sectors).map(timed),
        laps: l.NumberOfLaps ?? 0,
        pits: l.NumberOfPitStops ?? 0,
        inPit: !!l.InPit,
        pitOut: !!l.PitOut,
        retired: !!l.Retired,
        stopped: !!l.Stopped,
        knockedOut: !!l.KnockedOut,
        tyre,
        xy: pos ? [pos[0], pos[1]] : null,
        onTrack: pos ? pos[2] : false,
        lapState: lapState(l),
      });
    }
    drivers.sort((a, b) => (lines[a.num].Line ?? a.position) - (lines[b.num].Line ?? b.position));

    const info = r.SessionInfo as Obj | undefined;
    const session: SessionMeta | null = info
      ? {
          meeting: info.Meeting?.Name ?? "",
          name: info.Name ?? "",
          type: info.Type ?? "",
          circuit: info.Meeting?.Circuit?.ShortName ?? "",
          country: info.Meeting?.Country?.Name ?? "",
          path: info.Path ?? null,
          circuitKey: info.Meeting?.Circuit?.Key ?? null,
          year: Number(String(info.StartDate ?? info.Path ?? "").slice(0, 4)) || null,
        }
      : null;

    const clock = r.ExtrapolatedClock as Obj | undefined;
    let remainingMs = parseClock(clock?.Remaining);
    if (remainingMs !== null && clock?.Extrapolating) remainingMs = Math.max(0, remainingMs - (time - this.clockTs));

    const w = r.WeatherData as Obj | undefined;
    const weather: Weather | null = w
      ? {
          air: toNumber(w.AirTemp),
          track: toNumber(w.TrackTemp),
          humidity: toNumber(w.Humidity),
          rain: toNumber(w.Rainfall) === 1,
          windSpeed: toNumber(w.WindSpeed),
          windDir: toNumber(w.WindDirection),
        }
      : null;

    const raceControl: RaceControlMessage[] = asList<Obj>(r.RaceControlMessages?.Messages).map((m) => ({
      utc: m.Utc ?? "",
      lap: m.Lap ?? null,
      category: m.Category ?? "",
      flag: m.Flag ?? null,
      scope: m.Scope ?? null,
      sector: m.Sector ?? null,
      driver: m.RacingNumber ?? null,
      message: m.Message ?? "",
    }));

    // Amarillas por sector: vale la última bandera de cada sector; una bandera de pista las limpia todas.
    const yellow = new Map<number, boolean>();
    for (const m of raceControl) {
      if (m.category !== "Flag") continue;
      if (m.scope === "Track") yellow.clear();
      else if (m.scope === "Sector" && m.sector !== null) {
        if (m.flag === "YELLOW" || m.flag === "DOUBLE YELLOW") yellow.set(m.sector, m.flag === "DOUBLE YELLOW");
        else yellow.delete(m.sector);
      }
    }

    const lc = r.LapCount as Obj | undefined;
    return {
      time,
      utc: this.utcOffset !== null ? time + this.utcOffset : null,
      session,
      status: r.SessionStatus?.Status ?? "",
      track: { status: String(r.TrackStatus?.Status ?? ""), message: r.TrackStatus?.Message ?? "" },
      lap: lc?.CurrentLap ? { current: lc.CurrentLap, total: lc.TotalLaps ?? 0 } : null,
      remainingMs,
      part: this.sessionPart(),
      weather,
      drivers,
      raceControl,
      yellowSectors: [...yellow].map(([sector, double]) => ({ sector, double })),
      safetyCars: SAFETY_CARS.flatMap((id) => {
        const p = this.positions[id];
        return p && p[2] ? [{ id, xy: [p[0], p[1]] as [number, number] }] : [];
      }),
      topics: this.topics,
    };
  }
}

function timed(v: Obj | undefined): TimedValue {
  return { value: v?.Value ?? "", pb: !!v?.PersonalFastest, ob: !!v?.OverallFastest };
}

// Estado de mini-sector en el feed: 2048 sin mejora, 2049 mejor personal, 2051 mejor absoluto, 2064 calle de boxes.
const SEG_PB = 2049;
const SEG_OB = 2051;
const SEG_PIT = 2064;

function lapState(line: Obj): LapState {
  if (line.InPit) return "pit";
  if (line.PitOut) return "out";
  const sectors = asList<Obj>(line.Sectors);
  let n = 0, pb = 0, ob = 0;
  let sectorOb = false, sectorPb = false;
  for (const s of sectors) {
    const segs = asList<Obj>(s.Segments);
    let done = segs.length > 0;
    for (const g of segs) {
      if (!g?.Status) {
        done = false;
        continue;
      }
      if (g.Status === SEG_PIT) return "out";
      n++;
      if (g.Status === SEG_OB) ob++;
      else if (g.Status === SEG_PB) pb++;
    }
    // Sector ya cerrado en esta vuelta: vale su propia marca.
    if (done && s.Value) {
      sectorOb ||= !!s.OverallFastest;
      sectorPb ||= !!s.PersonalFastest;
    }
  }
  if (n === 0) {
    // Sin mini-sectores (datos de OpenF1): con la vuelta en curso, valen los sectores ya marcados.
    if (sectors.length < 3 || sectors[2].Value) return null;
    const cur = sectors.filter((s) => s.Value);
    if (!cur.length) return null;
    return cur.some((s) => s.OverallFastest) ? "purple" : cur.some((s) => s.PersonalFastest) ? "green" : "lap";
  }
  if (sectorOb) return "purple";
  if (sectorPb) return "green";
  if (n >= 3 && (pb + ob) / n >= 0.6) return ob >= pb ? "purple" : "green";
  return "lap";
}

/** Valida que los puntos formen una vuelta cerrada y sin saltos. */
function toOutline(pts: XY[]): TrackOutline | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of pts) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const diag = Math.hypot(maxX - minX, maxY - minY);
  if (diag < 1000) return null;
  const dist = (a: XY, b: XY) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  if (dist(pts[0], pts[pts.length - 1]) > diag * 0.08) return null;
  for (let i = 1; i < pts.length; i++) if (dist(pts[i - 1], pts[i]) > diag * 0.08) return null;
  return { points: pts, bounds: { minX, minY, maxX, maxY } };
}
