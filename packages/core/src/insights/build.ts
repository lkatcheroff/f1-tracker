import { StateEngine } from "../engine";
import { asList } from "../merge";
import { parseLapTime } from "../parse";
import type { RawMessage } from "../types";
import { PARAMS, type Params } from "./params";
import { parseSteward } from "./parse";
import type {
  ChangeClass,
  DataQuality,
  DataSourceKind,
  DriverInfo,
  InsightEvent,
  LapRow,
  PositionChange,
  SessionInsights,
  Stint,
} from "./types";

type Obj = Record<string, any>;

export interface BuildOptions {
  /** de dónde salen los mensajes: decide qué se rotula como aproximado */
  source: DataSourceKind;
  params?: Partial<Params>;
}

/** Intervalo de tiempo; `to: null` = sigue abierto. */
interface Span {
  from: number;
  to: number | null;
}

const inSpan = (spans: Span[] | undefined, t: number, margin = 0) =>
  !!spans?.some((s) => t >= s.from - margin && t <= (s.to ?? Number.POSITIVE_INFINITY) + margin);
const overlaps = (spans: Span[], a: number, b: number) => spans.some((s) => s.from <= b && (s.to ?? Number.POSITIVE_INFINITY) >= a);

interface DState {
  lapEnd: number | null;
  lapsClosed: number;
  flagIn: boolean;
  flagOut: boolean;
  sectors: (number | null)[];
  pitIn: number | null;
  pitLap: number;
  pits: Span[];
  stops: Span[];
}

interface Pending {
  num: string;
  lap: number;
  startTs: number;
  endTs: number;
  lapMs: number | null;
  inLap: boolean;
  outLap: boolean;
  sectors: (number | null)[];
  due: number;
}

interface RawFlip {
  flipTs: number;
  passer: string;
  passed: string;
  toPos: number;
}

const QUALITY: Record<DataSourceKind, string[]> = {
  official: [],
  openf1: [
    "Abandonos deducidos del resultado final de OpenF1",
    "Estado de pista (Safety Car, banderas) deducido de los mensajes de Race Control",
    "Mini-sectores repartidos en partes iguales a lo largo de cada sector",
    "Sin Safety Car en el mapa",
  ],
  recording: ["Sin posiciones ni telemetría: el feed en vivo sin cuenta de F1 no las trae"],
};

/**
 * Arma el análisis de una sesión recorriéndola una sola vez: tabla de vueltas, stints, cambios de posición
 * clasificados y eventos. Es puro y determinista, y funciona igual con los tres orígenes (archivo oficial, OpenF1,
 * grabación propia) porque todos hablan el mismo formato de mensajes.
 */
export function buildInsights(messages: RawMessage[], opts: BuildOptions): SessionInsights {
  const P: Params = { ...PARAMS, ...opts.params };
  const engine = new StateEngine({ gapSampleEvery: Number.POSITIVE_INFINITY });

  const drivers: Record<string, DriverInfo> = {};
  const states: Record<string, DState> = {};
  const state = (num: string): DState => {
    let s = states[num];
    if (!s) {
      s = {
        lapEnd: null,
        lapsClosed: 0,
        flagIn: false,
        flagOut: false,
        sectors: [null, null, null],
        pitIn: null,
        pitLap: 0,
        pits: [],
        stops: [],
      };
      states[num] = s;
    }
    return s;
  };

  let isRace = false;
  let startTs: number | null = null;
  let endTs: number | null = null;
  let leaderLap = 1;
  let hasPositions = false;
  let hasTelemetry = false;

  const pending: Pending[] = [];
  const rows: (LapRow & { startLaps: number })[] = [];
  const events: InsightEvent[] = [];
  let bestOverall = Number.POSITIVE_INFINITY;

  // orden de carrera
  const curPos: Record<string, number> = {};
  let orderDirty = false;
  let lastOrder: string[] | null = null;
  let gridOrder: string[] | null = null;
  const flips: RawFlip[] = [];
  const orderAt: { ts: number; order: string[] }[] = [];

  // estado de pista
  const neutral: Span[] = [];
  const yellow: Span[] = [];
  let neutralKind: string | null = null;
  let trackYellow = false;
  const yellowSectors = new Set<number>();
  const penaltyMsgs: { ts: number; drivers: string[] }[] = [];

  const updateYellow = (ts: number) => {
    const active = trackYellow || yellowSectors.size > 0;
    const open = yellow.length > 0 && yellow[yellow.length - 1].to === null;
    if (active && !open) yellow.push({ from: ts, to: null });
    else if (!active && open) yellow[yellow.length - 1].to = ts;
  };

  const setNeutral = (ts: number, kind: string | null) => {
    const open = neutral.length > 0 && neutral[neutral.length - 1].to === null;
    if (kind && !open) neutral.push({ from: ts, to: null });
    else if (!kind && open) neutral[neutral.length - 1].to = ts;
    if (kind && kind !== neutralKind) {
      events.push({
        id: "",
        kind: "neutralization",
        ts,
        seekTs: ts,
        lap: leaderLap,
        drivers: [],
        data: { type: kind },
        confidence: opts.source === "openf1" ? "approx" : "high",
      });
    }
    neutralKind = kind;
  };

  // --- orden de carrera ---

  const flushOrder = () => {
    if (!orderDirty) return;
    orderDirty = false;
    const nums = Object.keys(curPos);
    const n = nums.length;
    const seen = new Set(Object.values(curPos));
    if (n < 2 || seen.size !== n) return; // estado intermedio: se espera al próximo
    for (let i = 1; i <= n; i++) if (!seen.has(i)) return;
    const order = [...nums].sort((a, b) => curPos[a] - curPos[b]);
    const ts = lastOrder ? groupTs : 0;
    if (lastOrder && order.some((num, i) => num !== lastOrder![i])) {
      orderAt.push({ ts, order });
      // Solo en carrera: en práctica y clasificación el orden cambia por tiempos de vuelta, no por pasadas.
      const counting = isRace && startTs !== null && ts >= startTs;
      if (counting) {
        const oldPos = new Map(lastOrder.map((num, i) => [num, i + 1]));
        const newPos = new Map(order.map((num, i) => [num, i + 1]));
        for (const x of nums) {
          for (const y of nums) {
            if (x === y) continue;
            if (oldPos.get(x)! > oldPos.get(y)! && newPos.get(x)! < newPos.get(y)!)
              flips.push({ flipTs: ts, passer: x, passed: y, toPos: newPos.get(x)! });
          }
        }
      }
    } else if (!lastOrder) orderAt.push({ ts: 0, order });
    lastOrder = order;
    if (!gridOrder && !isRace) gridOrder = order;
  };

  const finalizeDue = (now: number, all = false) => {
    while (pending.length && (all || pending[0].due <= now)) {
      const p = pending.shift()!;
      const r = engine.peekRow(p.num);
      rows.push({
        driver: p.num,
        lap: p.lap,
        startTs: p.startTs,
        endTs: p.endTs,
        lapTimeMs: p.lapMs,
        position: r?.position ?? null,
        gapLeaderSec: r?.gapLeaderSec ?? null,
        intervalSec: r?.intervalSec ?? null,
        tyre: r?.stint ? { compound: r.stint.compound, age: 0, isNew: r.stint.isNew } : null,
        stint: r?.stint?.index ?? 0,
        startLaps: r?.stint?.startLaps ?? 0,
        inLap: p.inLap,
        outLap: p.outLap,
        neutralized: false,
        yellow: false,
        sectorsMs: [p.sectors[0], p.sectors[1], p.sectors[2]],
      });
    }
  };

  // --- recorrido ---

  let groupTs = Number.NEGATIVE_INFINITY;
  for (const m of messages) {
    if (m.ts !== groupTs) {
      flushOrder();
      groupTs = m.ts;
    }
    finalizeDue(m.ts);

    if (m.topic === "Position") {
      hasPositions = true;
      continue;
    }
    if (m.topic === "CarData") {
      hasTelemetry = true;
      continue;
    }
    const data = m.data as Obj;

    if (m.topic === "SessionInfo") {
      isRace = data?.Type === "Race";
    } else if (m.topic === "DriverList") {
      for (const [num, d] of Object.entries<Obj>(data ?? {})) {
        if (!d || typeof d !== "object") continue;
        drivers[num] = {
          ...drivers[num],
          tla: d.Tla ?? drivers[num]?.tla ?? num,
          name: d.FullName ?? drivers[num]?.name ?? num,
          team: d.TeamName ?? drivers[num]?.team ?? "",
          color: d.TeamColour ?? drivers[num]?.color ?? "888888",
        };
      }
    } else if (m.topic === "LapCount") {
      if (typeof data?.CurrentLap === "number") leaderLap = data.CurrentLap;
    } else if (m.topic === "SessionStatus") {
      if (data?.Status === "Started" && startTs === null) {
        startTs = m.ts;
        // Lo que se marcó en boxes antes de largar no cuenta para las vueltas.
        for (const s of Object.values(states)) {
          s.flagIn = false;
          s.flagOut = false;
          s.pitIn = null;
        }
        flushOrder();
        if (isRace && lastOrder) gridOrder = [...lastOrder];
      }
      if (data?.Status === "Finished" && isRace && endTs === null) endTs = m.ts;
    } else if (m.topic === "TrackStatus") {
      const status = String(data?.Status ?? "");
      if (status === "4") setNeutral(m.ts, "SC");
      else if (status === "6") setNeutral(m.ts, "VSC");
      else if (status === "5") setNeutral(m.ts, "RED");
      else if (status === "1") setNeutral(m.ts, null);
      if (status === "2") trackYellow = true;
      else if (status === "1" || status === "4" || status === "5" || status === "6") trackYellow = false;
      updateYellow(m.ts);
    } else if (m.topic === "RaceControlMessages") {
      for (const r of asList<Obj>(data?.Messages)) handleRaceControl(r, m.ts);
    } else if (m.topic === "TimingData") {
      const lines = (data?.Lines ?? {}) as Obj;
      const closings: { num: string; lap: number; ms: number | null; ob: boolean }[] = [];
      for (const num in lines) {
        const l = lines[num];
        if (!l || typeof l !== "object") continue;
        const ds = state(num);
        if (l.Position !== undefined) {
          const p = Number(l.Position);
          if (Number.isFinite(p)) {
            curPos[num] = p;
            orderDirty = true;
          }
        }
        if (l.Sectors && typeof l.Sectors === "object") {
          for (const k in l.Sectors) {
            const sec = parseLapTime(l.Sectors[k]?.Value);
            if (sec !== null && Number(k) >= 0 && Number(k) < 3) ds.sectors[Number(k)] = Math.round(sec * 1000);
          }
        }
        if (l.PitOut === true) ds.flagOut = true;
        if (l.InPit === true) {
          ds.flagIn = true;
          if (startTs !== null && ds.pitIn === null) {
            ds.pitIn = m.ts;
            ds.pitLap = ds.lapsClosed + 1;
          }
        } else if (l.InPit === false && ds.pitIn !== null) {
          ds.pits.push({ from: ds.pitIn, to: m.ts });
          const stops = ds.pits.length;
          events.push({
            id: "",
            kind: "pit",
            ts: m.ts,
            seekTs: ds.pitIn,
            lap: ds.pitLap,
            drivers: [num],
            data: { laneSec: Math.round((m.ts - ds.pitIn) / 100) / 10, stops, compound: null },
            confidence: opts.source === "openf1" ? "approx" : "high",
          });
          ds.pitIn = null;
        }
        if (l.Stopped === true && startTs !== null && !inSpan(ds.stops.length ? [ds.stops[ds.stops.length - 1]] : [], m.ts)) {
          ds.stops.push({ from: m.ts, to: null });
          if (neutralKind !== "RED") {
            events.push({
              id: "",
              kind: "retirement",
              ts: m.ts,
              seekTs: m.ts,
              lap: ds.lapsClosed + 1,
              drivers: [num],
              data: { lapsDone: ds.lapsClosed },
              confidence: opts.source === "openf1" ? "approx" : "high",
            });
          }
        } else if (l.Stopped === false && ds.stops.length && ds.stops[ds.stops.length - 1].to === null) {
          ds.stops[ds.stops.length - 1].to = m.ts;
        }
        if (typeof l.NumberOfLaps === "number" && l.NumberOfLaps > 0) {
          const sec = parseLapTime(l.LastLapTime?.Value);
          closings.push({ num, lap: l.NumberOfLaps, ms: sec ? Math.round(sec * 1000) : null, ob: l.LastLapTime?.OverallFastest === true });
        }
      }
      for (const c of closings) {
        const ds = state(c.num);
        const startOfLap = c.ms ? m.ts - c.ms : (ds.lapEnd ?? startTs ?? m.ts);
        pending.push({
          num: c.num,
          lap: c.lap,
          startTs: ds.lapEnd !== null && !c.ms ? ds.lapEnd : startOfLap,
          endTs: m.ts,
          lapMs: c.ms,
          inLap: ds.flagIn,
          outLap: ds.flagOut,
          sectors: [...ds.sectors],
          due: m.ts + P.LAP_SETTLE_MS,
        });
        if (c.ob && c.ms !== null && c.ms < bestOverall && (!isRace || c.lap >= P.FASTEST_LAP_FROM_LAP)) {
          events.push({
            id: "",
            kind: "fastestLap",
            ts: m.ts,
            seekTs: startOfLap,
            lap: c.lap,
            drivers: [c.num],
            data: { lapMs: c.ms, previousMs: Number.isFinite(bestOverall) ? bestOverall : null },
            confidence: "high",
          });
        }
        if (c.ms !== null && c.ms < bestOverall && c.ob) bestOverall = c.ms;
        ds.lapEnd = m.ts;
        ds.lapsClosed = c.lap;
        ds.flagIn = false;
        ds.flagOut = false;
        ds.sectors = [null, null, null];
      }
    }
    engine.apply(m);
  }
  flushOrder();
  finalizeDue(Number.POSITIVE_INFINITY, true);

  function handleRaceControl(r: Obj, ts: number) {
    const flag = r.Flag as string | undefined;
    if (flag === "CHEQUERED" && isRace && endTs === null) endTs = ts;
    if (r.Category === "Flag" && r.Scope === "Sector" && typeof r.Sector === "number") {
      if (flag === "YELLOW" || flag === "DOUBLE YELLOW") yellowSectors.add(r.Sector);
      else if (flag === "CLEAR") yellowSectors.delete(r.Sector);
      updateYellow(ts);
    } else if (r.Category === "Flag" && r.Scope === "Track" && flag === "CLEAR") {
      yellowSectors.clear();
      updateYellow(ts);
    }
    const s = parseSteward(String(r.Message ?? ""));
    if (!s?.drivers.length) return;
    const lap = typeof r.Lap === "number" ? r.Lap : leaderLap;
    if (s.kind === "penalty") {
      if (s.served) return;
      penaltyMsgs.push({ ts, drivers: s.drivers });
      events.push({
        id: "",
        kind: "penalty",
        ts,
        seekTs: ts,
        lap,
        drivers: s.drivers,
        data: { type: s.type, seconds: s.seconds, reason: s.reason },
        confidence: "high",
      });
    } else {
      events.push({
        id: "",
        kind: "investigation",
        ts,
        seekTs: ts,
        lap,
        drivers: s.drivers,
        data: { status: s.status, turn: s.turn, reason: s.reason },
        confidence: "high",
      });
    }
  }

  // --- cierres de las vueltas: sin posición, banderas ni edad de neumático hasta acá ---

  rows.sort((a, b) => a.endTs - b.endTs || a.driver.localeCompare(b.driver, undefined, { numeric: true }));
  for (const r of rows) {
    r.neutralized = overlaps(neutral, r.startTs, r.endTs);
    r.yellow = overlaps(yellow, r.startTs, r.endTs);
  }

  // stints y edad del neumático (vueltas que ya traía + vueltas en el stint)
  const stintMap = new Map<string, Stint>();
  for (const r of rows) {
    const key = `${r.driver}:${r.stint}`;
    let st = stintMap.get(key);
    if (!st) {
      st = {
        driver: r.driver,
        index: r.stint,
        compound: r.tyre?.compound ?? "",
        isNew: r.tyre?.isNew ?? false,
        lapStart: r.lap,
        lapEnd: r.lap,
        rows: [],
      };
      stintMap.set(key, st);
    }
    st.rows.push(r);
    st.lapEnd = r.lap;
    if (r.tyre) r.tyre.age = r.startLaps + st.rows.length;
  }
  const stints = [...stintMap.values()].sort((a, b) => +a.driver - +b.driver || a.index - b.index);
  const laps: LapRow[] = rows.map(({ startLaps: _s, ...r }) => r);

  // compuesto con el que sale cada parada = el de la vuelta de salida siguiente
  for (const e of events) {
    if (e.kind !== "pit") continue;
    const next = rows.find((r) => r.driver === e.drivers[0] && r.outLap && r.endTs >= e.ts);
    if (next?.tyre) e.data.compound = next.tyre.compound;
  }

  // --- cambios de posición ---

  const lapAt = (num: string, ts: number): number | null => {
    let n = 0;
    for (const r of rows) if (r.driver === num && r.endTs <= ts) n = r.lap;
    return isRace || n > 0 ? n + 1 : null;
  };

  // antirrebote: un cambio que se revierte antes de `OVERTAKE_DEBOUNCE_MS` no cuenta (se anulan los dos)
  const kept: RawFlip[] = [];
  const lastByPair = new Map<string, RawFlip>();
  const keyOf = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  for (const f of flips) {
    const k = keyOf(f.passer, f.passed);
    const prev = lastByPair.get(k);
    if (prev && prev.passer === f.passed && prev.passed === f.passer && f.flipTs - prev.flipTs <= P.OVERTAKE_DEBOUNCE_MS) {
      kept.splice(kept.indexOf(prev), 1);
      lastByPair.delete(k);
      continue;
    }
    kept.push(f);
    lastByPair.set(k, f);
  }

  const classify = (f: RawFlip): ChangeClass => {
    if (endTs !== null && f.flipTs > endTs) return "penalty";
    const near = (num: string) =>
      state(num).pits.some((s) => f.flipTs >= s.from - P.PIT_WINDOW_MS && f.flipTs <= (s.to ?? s.from) + P.PIT_WINDOW_MS);
    if (near(f.passer) || near(f.passed)) return "pitCycle";
    if (inSpan(state(f.passed).stops, f.flipTs) || inSpan(state(f.passer).stops, f.flipTs)) return "retirement";
    if (startTs !== null && f.flipTs <= startTs + P.START_WINDOW_MS) return "start";
    if (inSpan(neutral, f.flipTs)) return "neutralized";
    return "onTrack";
  };

  const changes: PositionChange[] = kept.map((f) => ({
    ts: f.flipTs + P.OVERTAKE_DEBOUNCE_MS,
    flipTs: f.flipTs,
    passer: f.passer,
    passed: f.passed,
    toPos: f.toPos,
    class: classify(f),
    lap: lapAt(f.passer, f.flipTs),
  }));

  const src = opts.source;
  for (const c of changes) {
    if (c.class === "onTrack" || (c.class === "pitCycle" && c.toPos === 1)) {
      events.push({
        id: "",
        kind: c.toPos === 1 ? "leadChange" : "overtake",
        ts: c.ts,
        seekTs: c.flipTs,
        lap: c.lap,
        drivers: [c.passer, c.passed],
        data: { toPos: c.toPos, afterPits: c.class === "pitCycle" },
        confidence: "high",
      });
    }
  }

  // la largada, en un solo evento
  const grid: Record<string, number> = {};
  gridOrder?.forEach((num, i) => {
    grid[num] = i + 1;
  });
  const final: Record<string, number> = {};
  // `lastOrder` se asigna dentro de `flushOrder`: TypeScript no ve ese cambio y lo da por null.
  (lastOrder as string[] | null)?.forEach((num, i) => {
    final[num] = i + 1;
  });
  if (isRace && startTs !== null && gridOrder) {
    const windowEnd = startTs + P.START_WINDOW_MS;
    const atEnd = [...orderAt].reverse().find((o) => o.ts <= windowEnd)?.order ?? gridOrder;
    let gain: [string, number] = ["", 0];
    let loss: [string, number] = ["", 0];
    let moved = 0;
    atEnd.forEach((num, i) => {
      const d = grid[num] - (i + 1);
      if (d !== 0) moved++;
      if (d > gain[1]) gain = [num, d];
      if (d < loss[1]) loss = [num, d];
    });
    if (moved) {
      events.push({
        id: "",
        kind: "start",
        ts: windowEnd,
        seekTs: startTs,
        lap: 1,
        drivers: [gain[0] || loss[0], loss[0] || gain[0]].filter((x, i, a) => x && a.indexOf(x) === i),
        data: { gainDriver: gain[0] || null, gainN: gain[1], lossDriver: loss[0] || null, lossN: -loss[1], moved },
        confidence: "high",
      });
    }
  }

  // identificadores estables y orden final
  for (const e of events) e.id = `${e.kind}:${e.ts}:${e.drivers.join("-")}`;
  events.sort((a, b) => a.ts - b.ts || a.id.localeCompare(b.id));

  const quality: DataQuality = { source: src, hasPositions, hasTelemetry, approximations: QUALITY[src] };
  return { isRace, startTs, endTs, drivers, grid, final, laps, stints, events, changes, dataQuality: quality };
}
