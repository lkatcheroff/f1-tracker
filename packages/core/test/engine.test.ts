import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import {
  buildIndex,
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

  it("agrega elementos nuevos a un array (mensajes de Race Control)", () => {
    const state = deepMerge(undefined, { Messages: [{ Message: "a" }] });
    deepMerge(state, { Messages: { "1": { Message: "b" } } });
    expect((state as any).Messages).toEqual([{ Message: "a" }, { Message: "b" }]);
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
  "SessionStatus", "TrackStatus", "RaceControlMessages", "WeatherData", "ExtrapolatedClock", "Position.z",
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
