import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import {
  buildIndex,
  buildTelemetry,
  bestLap,
  currentLap,
  cutDrivers,
  deltaSeries,
  lapPool,
  packTelemetry,
  resolveRef,
  rivalOf,
  sectorTimes,
  unpackTelemetry,
  type OrderRow,
  type SessionTelemetry,
  type TelemetryLap,
  deepMerge,
  findOutline,
  parseGap,
  parseJsonStream,
  parseStreamTs,
  PlaybackClock,
  prepareMessages,
  StateEngine,
  type RawMessage,
  type Snapshot,
} from "../src";

describe("parser", () => {
  it("lee timestamps y tolera BOM", () => {
    const msgs = parseJsonStream("LapCount", '﻿00:00:05.870{"CurrentLap":1,"TotalLaps":51}\r\n00:58:45.378{"CurrentLap":2}\r\n');
    expect(msgs).toEqual([
      { topic: "LapCount", ts: 5870, data: { CurrentLap: 1, TotalLaps: 51 } },
      { topic: "LapCount", ts: 3525378, data: { CurrentLap: 2 } },
    ]);
    expect(parseStreamTs("02:34:55.607")).toBe(9295607);
  });

  it("interpreta los formatos de gap", () => {
    expect(parseGap("+12.345")).toBe(12.345);
    expect(parseGap("+1:02.345")).toBeCloseTo(62.345);
    expect(parseGap("LAP 14")).toBe(0);
    expect(parseGap("1L")).toBeNull();
    expect(parseGap("")).toBeNull();
  });
});

describe("deepMerge", () => {
  it("actualiza arrays con objetos de claves índice", () => {
    const state = deepMerge(undefined, { Sectors: [{ Value: "" }, { Value: "" }, { Value: "" }] });
    deepMerge(state, { Sectors: { "1": { Value: "44.492" } } });
    deepMerge(state, { Sectors: { "1": { PreviousValue: "44.492" }, "2": { Value: "25.1" } } });
    expect(state).toEqual({
      Sectors: [{ Value: "" }, { Value: "44.492", PreviousValue: "44.492" }, { Value: "25.1" }],
    });
  });

  it("tolera un delta que deja huecos en un array", () => {
    const engine = new StateEngine();
    engine.apply({ topic: "RaceControlMessages", ts: 0, data: { Messages: [{ Category: "Flag", Flag: "GREEN", Scope: "Track", Message: "a" }] } });
    engine.apply({ topic: "RaceControlMessages", ts: 1, data: { Messages: { "3": { Category: "Other", Message: "d" } } } });
    const s = engine.snapshot();
    expect(s.raceControl.map((m) => m.message)).toEqual(["a", "d"]);
    expect(s.yellowSectors).toEqual([]);
  });

  it("agrega elementos nuevos a un array (mensajes de Race Control)", () => {
    const state = deepMerge(undefined, { Messages: [{ Message: "a" }] });
    deepMerge(state, { Messages: { "1": { Message: "b" } } });
    expect((state as any).Messages).toEqual([{ Message: "a" }, { Message: "b" }]);
  });
});

describe("corte de clasificación", () => {
  const line = (num: string, pos: number, best: string, extra: Record<string, unknown> = {}) => [
    num,
    { RacingNumber: num, Line: pos, Position: String(pos), BestLapTime: { Value: best }, Sectors: [], ...extra },
  ];
  it("calcula el margen de cada piloto contra el corte de la parte", () => {
    const engine = new StateEngine();
    engine.apply({
      topic: "TimingData",
      ts: 0,
      data: {
        SessionPart: 2,
        NoEntries: [22, 16, 10],
        Lines: Object.fromEntries([
          ...Array.from({ length: 9 }, (_, i) => line(String(i + 1), i + 1, `1:4${i}.000`)),
          line("10", 10, "1:45.000"),
          line("11", 11, "1:45.250"),
          line("12", 12, "", {}),
          line("17", 17, "1:46.000", { KnockedOut: true }),
        ]),
      },
    });
    const s = engine.snapshot();
    const by = Object.fromEntries(s.drivers.map((d) => [d.num, d]));
    expect(s.part).toBe(2);
    expect(s.through).toBe(10);
    expect(by["10"]).toMatchObject({ cutGap: 0.25, inCutZone: false });
    expect(by["1"].cutGap).toBeCloseTo(5.25, 3);
    expect(by["11"]).toMatchObject({ cutGap: -0.25, inCutZone: true });
    expect(by["12"]).toMatchObject({ cutGap: null, inCutZone: true });
    expect(by["17"]).toMatchObject({ cutGap: null, inCutZone: false, knockedOut: true });
  });
});

describe("PlaybackClock", () => {
  it("avanza según velocidad y respeta la pausa", () => {
    const c = new PlaybackClock();
    c.seek(10_000, 0);
    expect(c.now(5000)).toBe(10_000);
    c.resume(5000);
    expect(c.now(6000)).toBe(11_000);
    c.setSpeed(4, 6000);
    expect(c.now(7000)).toBe(15_000);
    c.pause(7000);
    expect(c.now(99_000)).toBe(15_000);
  });
});

// --- Sesión real: carrera de Azerbaiyán 2026 (bajar con `npm run fixture`) ---

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../fixtures/2026-09-26_Azerbaijan_Grand_Prix_Race");
const HAS_FIXTURE = existsSync(path.join(FIXTURE, "TimingData.jsonStream"));
const TOPICS = [
  "SessionInfo", "Heartbeat", "DriverList", "TimingData", "TimingAppData", "TimingStats", "LapCount",
  "SessionStatus", "TrackStatus", "RaceControlMessages", "WeatherData", "ExtrapolatedClock", "Position.z", "CarData.z",
];

describe.skipIf(!HAS_FIXTURE)("StateEngine contra la fixture", () => {
  let messages: RawMessage[];

  beforeAll(() => {
    const raw: RawMessage[] = [];
    for (const t of TOPICS) raw.push(...parseJsonStream(t, readFileSync(path.join(FIXTURE, `${t}.jsonStream`), "utf8")));
    messages = prepareMessages(raw);
  }, 60_000);

  const stateAt = (clock: string, engine = new StateEngine()): Snapshot => {
    const ts = parseStreamTs(clock);
    for (let i = engine.seq; i < messages.length && messages[i].ts <= ts; i++) engine.apply(messages[i]);
    return engine.snapshot(ts);
  };
  const row = (s: Snapshot, i: number) => {
    const d = s.drivers[i];
    return [d.position, d.tla, d.gap, d.interval, d.tyre?.compound, d.tyre?.age];
  };

  it("grilla antes de la largada", () => {
    const s = stateAt("00:56:00.000");
    expect(s.status).toBe("Inactive");
    expect(s.session).toMatchObject({ meeting: "Azerbaijan Grand Prix", name: "Race", circuit: "Baku" });
    expect(s.drivers).toHaveLength(22);
    expect(s.drivers.slice(0, 5).map((d) => d.tla)).toEqual(["RUS", "LEC", "PIA", "HAD", "NOR"]);
    expect(s.raceControl).toHaveLength(14);
  });

  it("vuelta 14: posiciones, gaps y neumáticos", () => {
    const s = stateAt("01:20:30.000");
    expect(s.lap).toEqual({ current: 14, total: 51 });
    expect(s.status).toBe("Started");
    expect(s.track.message).toBe("AllClear");
    expect(row(s, 0)).toEqual([1, "RUS", "LAP 14", "LAP 14", "MEDIUM", 15]);
    expect(row(s, 1)).toEqual([2, "PIA", "+6.908", "+6.908", "SOFT", 12]);
    expect(row(s, 2)).toEqual([3, "VER", "+7.579", "+0.685", "MEDIUM", 12]);
    expect(row(s, 4)).toEqual([5, "LEC", "+11.423", "+2.778", "SOFT", 12]);
    expect(s.drivers[0].gapSec).toBe(0);
    expect(s.drivers[1].gapSec).toBe(6.908);
    expect(s.drivers[0].lastLap.value).toBe("1:47.607");
    expect(s.drivers[0].sectors.map((x) => x.value)).toEqual(["38.265", "43.885", "25.457"]);
    expect(s.drivers[21]).toMatchObject({ tla: "STR", stopped: true, laps: 7 });
  });

  it("vuelta 32: safety car y paradas", () => {
    const s = stateAt("01:55:00.000");
    expect(s.lap?.current).toBe(32);
    expect(s.track).toEqual({ status: "4", message: "SCDeployed" });
    expect(row(s, 0)).toEqual([1, "RUS", "LAP 32", "LAP 32", "SOFT", 0]);
    expect(row(s, 3)).toEqual([4, "HAD", "+13.792", "+2.171", "MEDIUM", 0]);
    expect(s.drivers[0].pits).toBe(1);
    expect(s.drivers[20]).toMatchObject({ tla: "ALO", retired: true });
    expect(s.raceControl).toHaveLength(41);
  });

  it("clasificación final", () => {
    const s = stateAt("02:41:00.000");
    expect(s.status).toBe("Finished");
    expect(s.drivers.slice(0, 6).map((d) => [d.tla, d.gap])).toEqual([
      ["RUS", "LAP 51"],
      ["VER", "+0.196"],
      ["HAD", "+10.704"],
      ["LEC", "+14.136"],
      ["ANT", "+14.512"],
      ["HAM", "+22.382"],
    ]);
    expect(s.drivers[0].bestLap).toBe("1:44.916");
  });

  it("un seek hacia atrás reconstruye el mismo estado desde un checkpoint", () => {
    const direct = stateAt("01:20:30.000");
    const engine = new StateEngine({ checkpointEvery: 30_000 });
    stateAt("02:41:00.000", engine);
    const histEnd = engine.history.length;
    const seq = engine.rewindTo(parseStreamTs("01:20:30.000"));
    expect(seq).toBeGreaterThan(0);
    expect(engine.time).toBeGreaterThan(parseStreamTs("01:19:55.000"));
    expect(engine.history.length).toBeLessThan(histEnd);
    const after = stateAt("01:20:30.000", engine);
    expect(after.drivers).toEqual(direct.drivers);
    expect(after.raceControl).toEqual(direct.raceControl);
    expect(after.lap).toEqual(direct.lap);
    // y volver a avanzar da el mismo final
    expect(stateAt("02:41:00.000", engine).drivers[1].gap).toBe("+0.196");
    expect(engine.history.length).toBe(histEnd);
  });

  it("muestrea los gaps solo con la sesión en curso", () => {
    const engine = new StateEngine();
    stateAt("01:20:30.000", engine);
    expect(engine.history[0].t).toBeGreaterThanOrEqual(parseStreamTs("00:56:53.247"));
    const last = engine.history[engine.history.length - 1];
    expect(last.lap).toBe(14);
    expect(last.gaps["63"]).toBe(0);
    expect(last.gaps["81"]).toBeCloseTo(6.9, 0);
    expect(last.gaps["18"]).toBeNull();
  });

  it("arma el índice de navegación", () => {
    const index = buildIndex(messages);
    expect(index.starts).toEqual([parseStreamTs("00:56:53.247")]);
    expect(index.totalLaps).toBe(51);
    expect(index.laps[0]).toEqual({ lap: 1, ts: index.starts[0] });
    expect(index.laps.find((l) => l.lap === 14)?.ts).toBeLessThan(parseStreamTs("01:20:30.000"));
    expect(index.events.some((e) => e.kind === "track" && e.value === "SCDeployed")).toBe(true);
  });

  it("saca el trazado de una vuelta limpia y ubica los autos", () => {
    const outline = findOutline(messages);
    expect(outline).not.toBeNull();
    expect(outline!.points.length).toBeGreaterThan(200);
    const s = stateAt("01:20:30.000");
    const { minX, maxX, minY, maxY } = outline!.bounds;
    const lead = s.drivers[0];
    expect(lead.onTrack).toBe(true);
    expect(lead.xy![0]).toBeGreaterThanOrEqual(minX - 500);
    expect(lead.xy![0]).toBeLessThanOrEqual(maxX + 500);
    expect(lead.xy![1]).toBeGreaterThanOrEqual(minY - 500);
    expect(lead.xy![1]).toBeLessThanOrEqual(maxY + 500);
  });
});

describe.skipIf(!HAS_FIXTURE)("señales para el mapa", () => {
  let messages: RawMessage[];
  beforeAll(() => {
    const raw: RawMessage[] = [];
    for (const t of TOPICS) raw.push(...parseJsonStream(t, readFileSync(path.join(FIXTURE, `${t}.jsonStream`), "utf8")));
    messages = prepareMessages(raw);
  }, 60_000);
  const stateAt = (clock: string) => {
    const engine = new StateEngine();
    const ts = parseStreamTs(clock);
    for (let i = 0; i < messages.length && messages[i].ts <= ts; i++) engine.apply(messages[i]);
    return engine.snapshot(ts);
  };

  it("el trazado arranca en la meta y marca los límites de sector", () => {
    const outline = findOutline(messages)!;
    const [x0, y0] = outline.points[0];
    // La línea de meta de Bakú queda antes de la grilla: a menos de 150 m del poleman parado en su cajón.
    const pole = stateAt("00:56:00.000").drivers[0].xy!;
    expect(Math.hypot(x0 - pole[0], y0 - pole[1])).toBeLessThan(1500);
    expect(outline.marks?.s2).toBeDefined();
    expect(outline.marks?.s3).toBeDefined();
  });

  it("reconstruye la calle de boxes: empieza y termina pegada a la pista, cerca de la recta principal", () => {
    const outline = findOutline(messages)!;
    const pit = outline.pit!;
    expect(pit.length).toBeGreaterThan(20);
    const toTrack = (p: [number, number]) => Math.min(...outline.points.map((q) => Math.hypot(q[0] - p[0], q[1] - p[1])));
    expect(toTrack(pit[0])).toBeLessThan(400);
    expect(toTrack(pit[pit.length - 1])).toBeLessThan(400);
    // el garage de Bakú está junto a la grilla
    const pole = stateAt("00:56:00.000").drivers[0].xy!;
    expect(Math.min(...pit.map((p) => Math.hypot(p[0] - pole[0], p[1] - pole[1])))).toBeLessThan(1000);
  });

  it("ubica el Safety Car solo mientras está desplegado y recuerda dónde quedó un auto detenido", () => {
    expect(stateAt("01:55:00.000").safetyCars.map((c) => c.id)).toEqual(["241"]);
    expect(stateAt("01:20:30.000").safetyCars).toEqual([]);
    expect(stateAt("02:20:00.000").safetyCars).toEqual([]);
    // STR abandona en la vuelta 8 y su posición pasa a 0,0 en el feed
    const str = stateAt("01:20:30.000").drivers.find((d) => d.tla === "STR")!;
    expect(str.stopped).toBe(true);
    expect(str.xy).not.toBeNull();
    expect(str.onTrack).toBe(false);
  });

  it("identifica circuito, amarillas por sector y estado de vuelta", () => {
    const s = stateAt("02:14:05.000");
    expect(s.session).toMatchObject({ circuitKey: 144, year: 2026 });
    // 02:14:03: YELLOW IN TRACK SECTOR 2 y 1; se limpian a las 02:14:09 y 02:14:10
    expect(s.yellowSectors.map((y) => y.sector).sort()).toEqual([1, 2]);
    expect(stateAt("01:20:30.000").yellowSectors).toEqual([]);
    expect(stateAt("00:56:00.000").drivers.every((d) => d.lapState === "pit" || d.lapState === null || d.lapState === "out" || d.lapState === "lap")).toBe(true);
    const racing = stateAt("01:20:30.000").drivers.filter((d) => !d.stopped);
    expect(racing.every((d) => ["lap", "green", "purple"].includes(d.lapState!))).toBe(true);
  });
});

describe.skipIf(!HAS_FIXTURE)("telemetría y mini-sectores", () => {
  let messages: RawMessage[];
  let tel: SessionTelemetry;
  beforeAll(() => {
    const raw: RawMessage[] = [];
    for (const t of TOPICS) raw.push(...parseJsonStream(t, readFileSync(path.join(FIXTURE, `${t}.jsonStream`), "utf8")));
    messages = prepareMessages(raw);
    tel = buildTelemetry(messages, findOutline(messages))!;
  }, 60_000);

  const lap = (driver: string, n: number) => tel.laps.find((l) => l.d === driver && l.n === n)!;

  it("normaliza CarData.z en una muestra por mensaje, con los canales verificados", () => {
    const cars = messages.filter((m) => m.topic === "CarData");
    expect(cars.length).toBeGreaterThan(30_000);
    const [speed, rpm, gear, throttle, brake] = (cars[3000].data as Record<string, number[]>)["63"];
    expect(speed).toBeLessThanOrEqual(340);
    expect(rpm).toBeLessThanOrEqual(14_000);
    expect(gear).toBeLessThanOrEqual(8);
    expect(throttle).toBeLessThanOrEqual(100);
    expect([0, 1]).toContain(brake);
    expect(cars[3000].utc).toBeGreaterThan(Date.parse("2026-09-26T10:00:00Z"));
  });

  it("el mensaje CarData no altera el estado de la sesión", () => {
    const engine = new StateEngine();
    for (const m of messages.slice(0, 20_000)) engine.apply(m);
    expect(engine.snapshot().topics["CarData"]?.count).toBeGreaterThan(0);
    expect(engine.snapshot().drivers.length).toBe(22);
  });

  it("muestra los mini-sectores de la vuelta en curso", () => {
    const engine = new StateEngine();
    const ts = parseStreamTs("01:20:30.000");
    for (let i = 0; i < messages.length && messages[i].ts <= ts; i++) engine.apply(messages[i]);
    const s = engine.snapshot(ts);
    const pia = s.drivers.find((d) => d.tla === "PIA")!;
    expect(pia.minis).toHaveLength(3);
    expect(pia.minis.every((m) => m.length >= 6)).toBe(true);
    const codes = new Set(pia.minis.flat());
    for (const c of codes) expect([0, 2048, 2049, 2051, 2064]).toContain(c);
    expect(pia.minis[0].some((c) => c !== 0)).toBe(true); // ya pasó por el sector 1
    expect(pia.minis[2].length).toBeGreaterThanOrEqual(6); // el 3 también viene en la lista, aunque falte cruzar la meta
  });

  it("arma la telemetría de las vueltas lanzadas, con el tiempo oficial", () => {
    expect(tel.length).toBeGreaterThan(5800);
    expect(tel.length).toBeLessThan(6100);
    expect(tel.laps.length).toBeGreaterThan(900);
    const l = lap("63", 14);
    expect(l.kind).toBe("flying");
    expect(l.tyre).toBe("MEDIUM");
    expect(l.t).toHaveLength(tel.grid);
    expect(l.t[0]).toBe(0);
    expect(l.t[l.t.length - 1]).toBe(l.ms);
    expect(l.t.every((x, i) => i === 0 || x >= l.t[i - 1])).toBe(true);
    expect(Math.max(...l.v)).toBeGreaterThan(300);
    expect(Math.max(...l.th)).toBe(100);
    expect(new Set(l.br)).toEqual(new Set([0, 1]));
    expect(Math.max(...l.g)).toBe(8);
  });

  it("marca como boxes las vueltas de entrada y de salida, y descarta la de largada", () => {
    expect(new Set(tel.laps.map((l) => l.kind))).toEqual(new Set(["flying", "in", "out"]));
    expect(tel.laps.some((l) => l.n === 1)).toBe(false);
    // RUS paró dos veces. La vuelta de entrada de la segunda parada (bajo Safety Car, V36) se descarta porque
    // el cronometraje oficial no coincide con lo medido: preferimos perder la vuelta a mostrar un tiempo dudoso.
    const rus = tel.laps.filter((l) => l.d === "63" && l.kind !== "flying").map((l) => `${l.n}:${l.kind}`);
    expect(rus).toEqual(["31:in", "32:out", "37:out"]);
  });

  it("calcula los sectores desde la traza y suman el tiempo de vuelta", () => {
    const l = lap("63", 14);
    const sec = sectorTimes(l, tel.marks)!;
    expect(sec.reduce((a, b) => a + b, 0)).toBeCloseTo(l.ms, 5);
    // sectores de una vuelta lanzada en Bakú: ~38 s, ~44 s y ~25 s
    expect(sec[0] / 1000).toBeGreaterThan(36);
    expect(sec[0] / 1000).toBeLessThan(41);
    expect(sec[1] / 1000).toBeGreaterThan(42);
    expect(sec[1] / 1000).toBeLessThan(47);
    expect(sec[2] / 1000).toBeGreaterThan(24);
    expect(sec[2] / 1000).toBeLessThan(27);
  });

  it("la diferencia al final de la vuelta es la diferencia de tiempos oficial", () => {
    const a = lap("63", 14);
    const b = lap("81", 14);
    const d = deltaSeries(a, b);
    expect(d[0]).toBe(0);
    expect(d[d.length - 1]).toBeCloseTo((a.ms - b.ms) / 1000, 3);
    expect(deltaSeries(a, a).every((x) => x === 0)).toBe(true);
  });

  it("sigue la vuelta en curso: solo ve lo recorrido hasta ahora", () => {
    const l = lap("63", 14);
    const mid = l.s + 40_000;
    const cur = currentLap(tel, "63", mid)!;
    expect(cur.lap.n).toBe(14);
    expect(l.t[cur.upto]).toBeLessThanOrEqual(40_000);
    expect(l.t[cur.upto + 1]).toBeGreaterThan(40_000);
    expect(currentLap(tel, "63", l.e + 1)?.lap.n).not.toBe(14);
    expect(currentLap(tel, "63", 0)).toBeNull();
  });

  it("sin spoilers, la mejor vuelta de referencia es la mejor hasta ese momento", () => {
    const order: OrderRow[] = [{ num: "63", tla: "RUS", team: "Mercedes", knockedOut: false, retired: false }];
    const ctx = { tel, now: lap("63", 14).s + 30_000, spoilerFree: true, part: null, through: null, order };
    const pool = lapPool(ctx);
    expect(pool.every((l) => l.e <= ctx.now)).toBe(true);
    const ref = resolveRef(ctx, lap("63", 14), { kind: "best" });
    expect(ref.lap).toBe(bestLap(pool));
    // con spoilers apagados entra todo, y la mejor es la de toda la carrera (1:44.916 de RUS)
    const all = resolveRef({ ...ctx, spoilerFree: false }, lap("63", 14), { kind: "best" });
    expect(all.lap!.ms).toBe(Math.min(...tel.laps.filter((l) => l.kind === "flying").map((l) => l.ms)));
    expect(all.lap!.ms).toBeLessThanOrEqual(ref.lap!.ms);
  });

  it("ida y vuelta por el archivo conserva las vueltas", () => {
    const back = unpackTelemetry(packTelemetry(tel));
    expect(back.laps).toHaveLength(tel.laps.length);
    const a = lap("63", 14);
    const b = back.laps.find((l) => l.d === "63" && l.n === 14)!;
    expect(b.t).toEqual(a.t);
    expect(b.v).toEqual(a.v);
    expect(b.br).toEqual(a.br);
    expect(b.r[100]).toBeCloseTo(a.r[100], -2); // las rpm se guardan redondeadas a la decena
  });
});

describe("referencias de comparación", () => {
  const mk = (d: string, n: number, ms: number, part: number | null, kind: TelemetryLap["kind"] = "flying"): TelemetryLap => ({
    d, n, s: n * 100_000, e: n * 100_000 + ms, ms, kind, part, tyre: "SOFT", age: 1,
    t: [0, ms / 2, ms], v: [0, 0, 0], th: [0, 0, 0], br: [0, 0, 0], g: [1, 1, 1], r: [0, 0, 0],
  });
  const tel: SessionTelemetry = {
    v: 1, length: 5000, grid: 3, marks: [0.3, 0.7],
    laps: [mk("1", 3, 90_000, 2), mk("1", 4, 91_000, 2), mk("2", 3, 90_500, 2), mk("3", 3, 89_900, 2), mk("3", 2, 95_000, 1), mk("4", 3, 92_000, 2, "out")],
  };
  const order: OrderRow[] = [
    { num: "3", tla: "AAA", team: "Alfa", knockedOut: false, retired: false },
    { num: "1", tla: "BBB", team: "Beta", knockedOut: false, retired: false },
    { num: "2", tla: "CCC", team: "Beta", knockedOut: false, retired: false },
    { num: "4", tla: "DDD", team: "Delta", knockedOut: false, retired: false },
  ];
  const ctx = { tel, now: 1e9, spoilerFree: true, part: 2, through: 2, order };

  it("el corte son el último que pasa y el primero que queda afuera", () => {
    const { lastIn, firstOut } = cutDrivers(order, 2);
    expect(lastIn?.tla).toBe("BBB");
    expect(firstOut?.tla).toBe("CCC");
    expect(cutDrivers(order, null)).toEqual({ lastIn: null, firstOut: null });
    expect(cutDrivers(order.map((d) => (d.num === "1" ? { ...d, knockedOut: true } : d)), 2).lastIn?.tla).toBe("CCC");
  });

  it("compara con el corte usando la mejor vuelta de esa parte", () => {
    const a = tel.laps[0];
    expect(resolveRef(ctx, a, { kind: "cut-in" }).lap).toBe(tel.laps[0]); // BBB: su mejor de Q2 es la V3 (90.000)
    expect(resolveRef(ctx, a, { kind: "cut-out" }).lap).toBe(tel.laps[2]); // CCC
    expect(resolveRef({ ...ctx, part: 1 }, a, { kind: "cut-out" }).missing).toMatch(/todavía no marcó/);
    expect(resolveRef({ ...ctx, through: null }, a, { kind: "cut-in" }).missing).toBeDefined();
  });

  it("ignora las vueltas de boxes al buscar la mejor y compara con otro piloto o con la anterior", () => {
    const a = tel.laps[1]; // BBB, V4
    expect(resolveRef(ctx, a, { kind: "best" }).lap).toBe(tel.laps[3]);
    expect(resolveRef(ctx, a, { kind: "own" }).lap).toBe(tel.laps[0]);
    expect(resolveRef(ctx, a, { kind: "prev" }).lap).toBe(tel.laps[0]);
    expect(resolveRef(ctx, tel.laps[0], { kind: "prev" }).missing).toBeDefined();
    expect(resolveRef(ctx, a, { kind: "driver", driver: "4" }).missing).toBeDefined(); // solo tiene una vuelta de boxes
    expect(resolveRef(ctx, a, { kind: "driver", driver: "3", lap: 2 }).lap).toBe(tel.laps[4]);
  });

  it("encuentra al compañero y a los autos de al lado", () => {
    expect(rivalOf(order, "1", "teammate")?.tla).toBe("CCC");
    expect(rivalOf(order, "1", "ahead")?.tla).toBe("AAA");
    expect(rivalOf(order, "1", "behind")?.tla).toBe("CCC");
    expect(rivalOf(order, "3", "ahead")).toBeNull();
    expect(rivalOf(order, "4", "teammate")).toBeNull();
  });
});
