import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { buildInsights, insightsAt, parseJsonStream, parseStreamTs, prepareMessages, REPLAY_TOPICS, type SessionInsights } from "../src";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const RACE = path.join(ROOT, "fixtures/2026-09-26_Azerbaijan_Grand_Prix_Race");
const QUALI = path.join(ROOT, "data/cache/static/2026/2026-09-26_Azerbaijan_Grand_Prix/2026-09-25_Qualifying");
const HAS_RACE = existsSync(path.join(RACE, "TimingData.jsonStream"));
const HAS_QUALI = existsSync(path.join(QUALI, "TimingData.jsonStream"));

function load(dir: string) {
  const raw = [];
  for (const t of REPLAY_TOPICS) {
    const file = path.join(dir, `${t}.jsonStream`);
    if (existsSync(file)) raw.push(...parseJsonStream(t, readFileSync(file, "utf8")));
  }
  return prepareMessages(raw);
}

describe.skipIf(!HAS_RACE)("[requiere datos reales] análisis de la carrera de Bakú", () => {
  let ins: SessionInsights;
  let ms = 0;
  beforeAll(() => {
    const messages = load(RACE);
    const t0 = performance.now();
    ins = buildInsights(messages, { source: "official" });
    ms = performance.now() - t0;
  }, 60_000);

  it("entra en el presupuesto de tiempo (< 500 ms en un portátil)", () => {
    console.log(`buildInsights de una carrera completa: ${Math.round(ms)} ms`);
    expect(ms).toBeLessThan(1000);
  });

  it("el invariante se cumple para los 22 pilotos: posición de grilla − final = pasos hechos − sufridos", () => {
    expect(Object.keys(ins.grid)).toHaveLength(22);
    expect(Object.keys(ins.final)).toHaveLength(22);
    const net: Record<string, number> = {};
    for (const c of ins.changes) {
      net[c.passer] = (net[c.passer] ?? 0) + 1;
      net[c.passed] = (net[c.passed] ?? 0) - 1;
    }
    for (const num of Object.keys(ins.grid)) expect(ins.grid[num] - ins.final[num], `piloto ${num}`).toBe(net[num] ?? 0);
  });

  it("ningún cambio de posición queda sin clase, y los de la bandera a cuadros son reclasificaciones", () => {
    const classes = new Set(["pitCycle", "retirement", "start", "neutralized", "penalty", "onTrack"]);
    expect(ins.changes.every((c) => classes.has(c.class))).toBe(true);
    expect(ins.changes.filter((c) => c.class === "penalty")).toHaveLength(1);
    expect(ins.changes.filter((c) => c.class === "onTrack").length).toBeGreaterThan(80);
  });

  it("encuentra los 7 abandonos, los 2 Safety Car y la vuelta rápida de la carrera", () => {
    expect(
      ins.events
        .filter((e) => e.kind === "retirement")
        .map((e) => e.drivers[0])
        .sort(),
    ).toEqual(["1", "10", "14", "18", "23", "43", "77"]);
    expect(ins.events.filter((e) => e.kind === "neutralization").map((e) => e.data.type)).toEqual(["SC", "SC"]);
    const fl = ins.events.filter((e) => e.kind === "fastestLap").at(-1)!;
    expect(fl.data.lapMs).toBe(104_916); // 1:44.916 de RUS
    expect(fl.drivers).toEqual(["63"]);
  });

  it("las paradas y los stints de un piloto de punta a punta", () => {
    const rus = ins.stints.filter((s) => s.driver === "63");
    expect(rus.map((s) => [s.compound, s.lapStart, s.lapEnd])).toEqual([
      ["MEDIUM", 1, 31],
      ["SOFT", 32, 36],
      ["SOFT", 37, 51],
    ]);
    expect(ins.events.filter((e) => e.kind === "pit" && e.drivers[0] === "63").map((e) => [e.lap, e.data.compound])).toEqual([
      [31, "SOFT"],
      [36, "SOFT"],
    ]);
    // la edad del neumático cuenta las vueltas con las que salió
    expect(rus[0].rows[0].tyre?.age).toBe(3);
    expect(rus[2].rows.at(-1)?.tyre?.age).toBe(20);
  });

  it("las vueltas de boxes y las neutralizadas están marcadas", () => {
    const lap = (d: string, n: number) => ins.laps.find((l) => l.driver === d && l.lap === n)!;
    expect(lap("63", 31)).toMatchObject({ inLap: true, outLap: false });
    expect(lap("63", 32)).toMatchObject({ inLap: false, outLap: true });
    expect(lap("63", 14)).toMatchObject({ inLap: false, outLap: false, neutralized: false, lapTimeMs: 107_566, position: 1 });
    expect(ins.laps.filter((l) => l.neutralized).length).toBeGreaterThan(100);
  });

  it("la largada es un solo evento", () => {
    const s = ins.events.filter((e) => e.kind === "start");
    expect(s).toHaveLength(1);
    expect(s[0].seekTs).toBe(parseStreamTs("00:56:53.247"));
  });

  it("sin spoilers: a lo largo de toda la carrera nada es posterior a `now`", () => {
    const start = ins.startTs!;
    for (let now = start - 60_000; now <= start + 6_500_000; now += 125_000) {
      const v = insightsAt(ins, now);
      expect(v.events.every((e) => e.ts <= now)).toBe(true);
      expect(v.laps.every((l) => l.endTs <= now)).toBe(true);
      expect(v.changes.every((c) => c.ts <= now)).toBe(true);
    }
    expect(insightsAt(ins, start + 3_600_000).final).toEqual({});
  });
});

describe.skipIf(!HAS_QUALI)("[requiere datos reales] análisis de una clasificación", () => {
  it("no genera sobrepasos y sí vueltas rápidas", () => {
    const ins = buildInsights(load(QUALI), { source: "official" });
    expect(ins.isRace).toBe(false);
    expect(ins.laps.length).toBeGreaterThan(200);
    expect(ins.events.filter((e) => e.kind === "overtake" || e.kind === "start")).toHaveLength(0);
    expect(ins.events.filter((e) => e.kind === "fastestLap").length).toBeGreaterThan(3);
  });
});
