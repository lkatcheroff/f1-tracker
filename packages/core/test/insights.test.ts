import { describe, expect, it } from "vitest";
import { buildInsights, insightsAt, PARAMS, parseSteward, type RawMessage, type SessionInsights, visible } from "../src";
import { RaceBuilder } from "./builders";

const T0 = 10_000;
const LAP = 90_000;
const DEBOUNCE = PARAMS.OVERTAKE_DEBOUNCE_MS;

const run = (r: RaceBuilder, source: "official" | "openf1" | "recording" = "official"): SessionInsights =>
  buildInsights(r.build(), { source });

/** Una carrera de `n` pilotos que largó, con la primera vuelta cerrada para todos. */
function started(n = 4, laps = 10, type: "Race" | "Practice" | "Qualifying" = "Race"): RaceBuilder {
  const r = new RaceBuilder({ drivers: n, laps, type });
  r.at(T0).start();
  return r;
}

describe("sanciones e incidentes de Race Control", () => {
  it("lee los formatos del feed", () => {
    expect(parseSteward("FIA STEWARDS: 5 SECOND TIME PENALTY FOR CAR 2 (BBB) - SPEEDING IN THE PIT LANE (15:34:00)")).toEqual({
      kind: "penalty",
      type: "time",
      drivers: ["2"],
      tlas: ["BBB"],
      seconds: 5,
      served: false,
      reason: "SPEEDING IN THE PIT LANE",
    });
    expect(parseSteward("FIA STEWARDS: DRIVE THROUGH PENALTY FOR CAR 3 (CCC) - YELLOW FLAG INFRINGEMENT")).toMatchObject({
      type: "drive-through",
      seconds: null,
    });
    expect(parseSteward("FIA STEWARDS: STOP-AND-GO PENALTY FOR CAR 3 (CCC) - STARTING PROCEDURE INFRINGEMENT")).toMatchObject({
      type: "stop-go",
    });
    expect(
      parseSteward("FIA STEWARDS: PENALTY SERVED - STOP-AND-GO PENALTY FOR CAR 3 (CCC) - STARTING PROCEDURE INFRINGEMENT"),
    ).toMatchObject({ served: true, type: "stop-go" });
    expect(
      parseSteward("FIA STEWARDS: WARNING FOR CAR 1 (AAA) - STARTING PROCEDURE INFRINGEMENT - OUT OF POSITION (12:02:45)"),
    ).toMatchObject({ type: "warning", reason: "STARTING PROCEDURE INFRINGEMENT - OUT OF POSITION" });
    expect(parseSteward("FIA STEWARDS: 10 SECOND TIME PENALTY FOR CAR 4 (DDD) (15:04:34)")).toMatchObject({ seconds: 10, reason: null });
  });

  it("lee los incidentes: estado, autos, curva y motivo", () => {
    expect(parseSteward("INCIDENT INVOLVING CARS 1 (AAA) AND 2 (BBB) NOTED - CAUSING A COLLISION (12:05:54)")).toEqual({
      kind: "investigation",
      status: "noted",
      drivers: ["1", "2"],
      tlas: ["AAA", "BBB"],
      turn: null,
      reason: "CAUSING A COLLISION",
    });
    expect(
      parseSteward("FIA STEWARDS: TURN 3 INCIDENT INVOLVING CARS 1 (AAA), 2 (BBB) AND 3 (CCC) UNDER INVESTIGATION - CAUSING A COLLISION"),
    ).toMatchObject({
      status: "investigation",
      drivers: ["1", "2", "3"],
      turn: 3,
    });
    expect(
      parseSteward("FIA STEWARDS: INCIDENT INVOLVING CAR 1 (AAA) WILL BE INVESTIGATED AFTER THE SPRINT - UNSAFE RELEASE (11:29:31)"),
    ).toMatchObject({ status: "after-session", reason: "UNSAFE RELEASE" });
    expect(
      parseSteward("FIA STEWARDS: INCIDENT INVOLVING CAR 1 (AAA) REVIEWED NO FURTHER INVESTIGATION - IGNORING BLUE FLAGS"),
    ).toMatchObject({ status: "cleared" });
    expect(parseSteward("FIA STEWARDS: INCIDENT INVOLVING CAR 1 (AAA) NO FURTHER ACTION - STARTING PROCEDURE INFRINGEMENT")).toMatchObject({
      status: "cleared",
    });
    expect(
      parseSteward("FIA STEWARDS: UPDATE: TURN 17 INCIDENT INVOLVING CARS 1 (AAA) AND 2 (BBB) UNDER INVESTIGATION - CAUSING A COLLISION"),
    ).toMatchObject({ turn: 17 });
  });

  it("ignora lo que no es de los comisarios", () => {
    for (const text of [
      "RACE START",
      "YELLOW IN TRACK SECTOR 3",
      "SAFETY CAR DEPLOYED",
      "CAR 1 (AAA) TIME 1:27.040 DELETED - TRACK LIMITS AT TURN 10",
      "OVERTAKE ENABLED",
    ]) {
      expect(parseSteward(text)).toBeNull();
    }
  });
});

describe("tabla de vueltas", () => {
  /** AAA y BBB cierran la vuelta 1; BBB para al final de la 1 y sale con duros; las dos siguientes vueltas con SC y amarilla. */
  function scenario() {
    const r = started(3);
    r.at(100_000).lap("1", 90_000, { gap: 0 }).lap("2", 90_800, { gap: 0.8, interval: 0.8 }).lap("3", 91_600, { gap: 1.6, interval: 0.8 });
    r.at(188_000).pitIn("2");
    r.at(190_000).lap("1", 90_000).lap("3", 91_000);
    r.at(190_600).lap("2", 90_600, { sectors: [30_000, 40_000, 20_600] });
    r.at(212_000).pitOut("2", { compound: "HARD" });
    r.at(230_000).yellow(4);
    r.at(232_000).yellow(4, true);
    r.at(260_000).safetyCar();
    r.at(280_000).lap("1", 90_000).lap("3", 90_000).lap("2", 110_000);
    r.at(300_000).allClear();
    return run(r);
  }

  it("una fila por vuelta cerrada, con tiempos, sectores y límites de cada vuelta", () => {
    const { laps } = scenario();
    expect(laps).toHaveLength(9);
    const a1 = laps.find((l) => l.driver === "1" && l.lap === 1)!;
    expect(a1).toMatchObject({ lapTimeMs: 90_000, endTs: 100_000, startTs: 10_000, position: 1, gapLeaderSec: 0 });
    expect(a1.sectorsMs).toEqual([30_600, 36_900, 22_500]);
    const a2 = laps.find((l) => l.driver === "1" && l.lap === 2)!;
    expect(a2.startTs).toBe(
      a1.endTs - 0 + 90_000 - 90_000 + 90_000 - 90_000 + 100_000 - 100_000 + a2.endTs - a2.endTs + (a2.startTs - a2.startTs),
    );
    expect(a2.startTs).toBe(100_000);
    const b2 = laps.find((l) => l.driver === "2" && l.lap === 2)!;
    expect(b2.sectorsMs).toEqual([30_000, 40_000, 20_600]);
  });

  it("posición, diferencia con el líder y con el de adelante al cierre", () => {
    const { laps } = scenario();
    const c1 = laps.find((l) => l.driver === "3" && l.lap === 1)!;
    expect(c1).toMatchObject({ position: 3, gapLeaderSec: 1.6, intervalSec: 0.8 });
    expect(laps.find((l) => l.driver === "1" && l.lap === 1)?.intervalSec).toBeNull(); // el líder no tiene intervalo
  });

  it("marca las vueltas de entrada y de salida de boxes, y el neumático de cada stint", () => {
    const { laps, stints } = scenario();
    const b = (n: number) => laps.find((l) => l.driver === "2" && l.lap === n)!;
    expect(b(1)).toMatchObject({ inLap: false, outLap: false, stint: 0 });
    expect(b(2)).toMatchObject({ inLap: true, outLap: false, stint: 0 });
    expect(b(3)).toMatchObject({ inLap: false, outLap: true, stint: 1 });
    expect(b(3).tyre).toMatchObject({ compound: "HARD", isNew: true, age: 1 });
    expect(b(2).tyre).toMatchObject({ compound: "MEDIUM", age: 2 });
    expect(stints.filter((s) => s.driver === "2").map((s) => [s.index, s.compound, s.lapStart, s.lapEnd])).toEqual([
      [0, "MEDIUM", 1, 2],
      [1, "HARD", 3, 3],
    ]);
  });

  it("detecta las vueltas con bandera amarilla y con Safety Car", () => {
    const { laps } = scenario();
    const third = (d: string) => laps.find((l) => l.driver === d && l.lap === 3)!;
    expect(third("1").yellow).toBe(true);
    expect(third("1").neutralized).toBe(true);
    const second = laps.find((l) => l.driver === "1" && l.lap === 2)!;
    expect(second).toMatchObject({ yellow: false, neutralized: false });
  });
});

describe("cambios de posición y sobrepasos", () => {
  it("un sobrepaso en pista es un evento con el momento en que quedó firme", () => {
    const r = started(3);
    r.at(150_000).pass("2", "1");
    const out = run(r);
    const ov = out.events.filter((e) => e.kind === "leadChange" || e.kind === "overtake");
    expect(ov).toHaveLength(1);
    expect(ov[0]).toMatchObject({ kind: "leadChange", drivers: ["2", "1"], ts: 150_000 + DEBOUNCE, seekTs: 150_000, confidence: "high" });
    expect(out.changes).toEqual([expect.objectContaining({ passer: "2", passed: "1", class: "onTrack", toPos: 1 })]);
  });

  it("fuera del primer puesto es un sobrepaso común", () => {
    const r = started(3);
    r.at(150_000).pass("3", "2");
    const e = run(r).events.find((x) => x.kind === "overtake")!;
    expect(e).toMatchObject({ drivers: ["3", "2"], data: { toPos: 2, afterPits: false } });
  });

  it("un cambio que se revierte antes del antirrebote se anula; después, cuenta", () => {
    const flicker = started(3);
    flicker.at(150_000).pass("3", "2");
    flicker.at(150_000 + DEBOUNCE - 500).pass("2", "3");
    const a = run(flicker);
    expect(a.changes).toHaveLength(0);
    expect(a.events.filter((e) => e.kind === "overtake")).toHaveLength(0);

    const duel = started(3);
    duel.at(150_000).pass("3", "2");
    duel.at(150_000 + DEBOUNCE + 2000).pass("2", "3");
    const b = run(duel);
    expect(b.changes.map((c) => [c.passer, c.passed])).toEqual([
      ["3", "2"],
      ["2", "3"],
    ]);
    expect(b.events.filter((e) => e.kind === "overtake")).toHaveLength(2);
  });

  it("un auto que pasa a dos en una maniobra genera dos cambios", () => {
    const r = started(3);
    r.at(150_000).order(["3", "1", "2"]);
    const out = run(r);
    expect(out.changes.map((c) => [c.passer, c.passed]).sort()).toEqual([
      ["3", "1"],
      ["3", "2"],
    ]);
  });

  it("clasifica cada cambio en una sola clase", () => {
    const r = started(6, 20);
    r.at(30_000).pass("2", "1"); // largada: vuelta 1, dentro de la ventana
    r.at(200_000).pitIn("3");
    r.at(215_000).pass("4", "3"); // 4 pasa a 3 mientras 3 está en boxes
    r.at(222_000).pitOut("3");
    r.at(300_000).retire("5");
    r.at(310_000).pass("6", "5"); // 6 pasa al retirado
    r.at(400_000).safetyCar();
    r.at(420_000).pass("4", "1"); // bajo Safety Car
    r.at(500_000).allClear();
    r.at(600_000).pass("4", "2"); // en pista, ya sin neutralización ni boxes
    r.at(700_000).finish();
    r.at(800_000).pass("3", "1"); // reclasificación tras la bandera
    r.penalty("6", { seconds: 5, reason: "SPEEDING IN THE PIT LANE" });
    const byPair = Object.fromEntries(run(r).changes.map((c) => [`${c.passer}>${c.passed}`, c.class]));
    expect(byPair).toEqual({
      "2>1": "start",
      "4>3": "pitCycle",
      "6>5": "retirement",
      "4>1": "neutralized",
      "4>2": "onTrack",
      "3>1": "penalty",
    });
  });

  it("el que toma la punta por las paradas es un cambio de líder 'tras las paradas'", () => {
    const r = started(3);
    r.at(250_000).pitIn("1");
    r.at(260_000).pass("2", "1");
    r.at(272_000).pitOut("1");
    const e = run(r).events.find((x) => x.kind === "leadChange")!;
    expect(e).toMatchObject({ drivers: ["2", "1"], data: { afterPits: true } });
    expect(run(r).events.filter((x) => x.kind === "overtake")).toHaveLength(0);
  });

  it("la largada es un solo evento con lo ganado y lo perdido, no un sobrepaso por cada cambio", () => {
    const r = started(5);
    r.at(T0 + 20_000).order(["1", "3", "2", "4", "5"]);
    r.at(T0 + 40_000).order(["3", "1", "2", "5", "4"]);
    r.at(T0 + 120_000).pass("4", "5");
    const out = run(r);
    const start = out.events.filter((e) => e.kind === "start");
    expect(start).toHaveLength(1);
    expect(start[0]).toMatchObject({ ts: T0 + PARAMS.START_WINDOW_MS, seekTs: T0, data: { gainDriver: "3", gainN: 2, moved: 5 } });
    // los cambios de la ventana de largada no generan sobrepasos; el de después sí
    expect(out.events.filter((e) => e.kind === "overtake").map((e) => e.drivers)).toEqual([["4", "5"]]);
  });

  it("sin estados intermedios inválidos: un mensaje con posiciones repetidas se ignora hasta que se corrige", () => {
    const r = started(3);
    const msgs = r.build();
    const lines = (num: string, pos: number) => ({ Line: pos, Position: String(pos) });
    const extra: RawMessage[] = [
      { topic: "TimingData", ts: 60_000, data: { Lines: { 2: lines("2", 1) } } }, // 1 y 2 en P1: inválido
      { topic: "TimingData", ts: 60_000, data: { Lines: { 1: lines("1", 2) } } }, // mismo ts: completa el cambio
    ];
    const out = buildInsights(
      [...msgs, ...extra].sort((a, b) => a.ts - b.ts),
      { source: "official" },
    );
    expect(out.changes.map((c) => [c.passer, c.passed])).toEqual([["2", "1"]]);
  });

  it("el invariante: posición de grilla − posición final = pasos hechos − pasos sufridos, para todos", () => {
    // Escenarios pseudoaleatorios pero reproducibles, con boxes, retiros, Safety Car y reclasificación.
    for (const seed of [1, 7, 42, 99, 2024]) {
      let s = seed;
      const rnd = () => {
        s = (s * 1664525 + 1013904223) % 4294967296;
        return s / 4294967296;
      };
      const n = 8;
      const r = started(n, 30);
      let order = Array.from({ length: n }, (_, i) => String(i + 1));
      let t = T0;
      for (let k = 0; k < 60; k++) {
        t += 3_000 + Math.floor(rnd() * 40_000);
        r.at(t);
        const roll = rnd();
        if (roll < 0.1) r.pitIn(order[Math.floor(rnd() * n)]);
        else if (roll < 0.14) r.safetyCar();
        else if (roll < 0.2) r.allClear();
        // varios puestos de golpe a veces, como en el feed
        const i = Math.floor(rnd() * (n - 1));
        const next = [...order];
        [next[i], next[i + 1]] = [next[i + 1], next[i]];
        if (rnd() < 0.3 && i + 2 < n) [next[i + 1], next[i + 2]] = [next[i + 2], next[i + 1]];
        r.order(next);
        order = next;
      }
      r.at(t + 60_000).finish();
      r.at(t + 90_000).order([...order].reverse().map((_, i, a) => a[a.length - 1 - i]));
      const out = run(r);
      const net: Record<string, number> = {};
      for (const c of out.changes) {
        net[c.passer] = (net[c.passer] ?? 0) + 1;
        net[c.passed] = (net[c.passed] ?? 0) - 1;
      }
      for (const num of Object.keys(out.grid)) {
        expect(out.grid[num] - out.final[num], `seed ${seed}, piloto ${num}`).toBe(net[num] ?? 0);
      }
    }
  });
});

describe("otros eventos", () => {
  it("vuelta rápida: solo si mejora al titular, y no la vuelta 1 de una carrera", () => {
    const r = started(3);
    r.at(100_000).lap("1", 90_000).lap("2", 90_500).lap("3", 91_000); // vuelta 1: no cuenta
    r.at(200_000).lap("1", 89_000).lap("2", 88_500);
    r.at(205_000).lap("3", 89_900); // mejora su marca pero no la del titular (88,5)
    r.at(300_000).lap("1", 88_000);
    const fl = run(r).events.filter((e) => e.kind === "fastestLap");
    expect(fl.map((e) => [e.drivers[0], e.data.lapMs, e.lap])).toEqual([
      ["1", 89_000, 2],
      ["2", 88_500, 2],
      ["1", 88_000, 3],
    ]);
    expect(fl[1].data.previousMs).toBe(89_000);
  });

  it("en práctica, la primera vuelta rápida también cuenta", () => {
    const r = started(2, 10, "Practice");
    r.at(100_000).lap("1", 90_000);
    expect(run(r).events.filter((e) => e.kind === "fastestLap")).toHaveLength(1);
  });

  it("parada: entrada, salida, tiempo en la calle de boxes y neumático que monta", () => {
    const r = started(2);
    r.at(100_000).lap("1", 90_000).lap("2", 90_500);
    r.at(188_000).pitIn("1");
    r.at(190_000).lap("1", 90_000);
    r.at(209_000).pitOut("1", { compound: "SOFT" });
    r.at(280_000).lap("1", 105_000);
    r.at(285_000).lap("2", 90_000);
    const pit = run(r).events.filter((e) => e.kind === "pit");
    expect(pit).toHaveLength(1);
    expect(pit[0]).toMatchObject({
      drivers: ["1"],
      seekTs: 188_000,
      ts: 209_000,
      lap: 2,
      data: { laneSec: 21, stops: 1, compound: "SOFT" },
    });
  });

  it("retiro: se marca al quedar parado; en OpenF1, como aproximado", () => {
    const r = started(3);
    r.at(100_000).lap("1", 90_000).lap("3", 91_000);
    r.at(120_000).retire("2");
    expect(run(r).events.find((e) => e.kind === "retirement")).toMatchObject({
      drivers: ["2"],
      ts: 120_000,
      lap: 1,
      confidence: "high",
      data: { lapsDone: 0 },
    });
    expect(run(r, "openf1").events.find((e) => e.kind === "retirement")?.confidence).toBe("approx");
  });

  it("Safety Car, virtual y bandera roja", () => {
    const r = started(3);
    r.at(100_000).safetyCar();
    r.at(150_000).allClear();
    r.at(200_000).safetyCar("VSC");
    r.at(230_000).allClear();
    r.at(300_000).redFlag();
    const n = run(r).events.filter((e) => e.kind === "neutralization");
    expect(n.map((e) => [e.ts, e.data.type])).toEqual([
      [100_000, "SC"],
      [200_000, "VSC"],
      [300_000, "RED"],
    ]);
  });

  it("sanciones e incidentes de Race Control, con el piloto del texto", () => {
    const r = started(3);
    r.at(100_000).steward("2", "UNDER INVESTIGATION", "CAUSING A COLLISION");
    r.at(120_000).penalty("2", { seconds: 10, reason: "CAUSING A COLLISION" });
    r.at(130_000).rc("FIA STEWARDS: PENALTY SERVED - STOP-AND-GO PENALTY FOR CAR 3 (CCC) - X");
    r.at(140_000).steward("1", "NOTED");
    const ev = run(r).events;
    expect(ev.filter((e) => e.kind === "penalty")).toEqual([
      expect.objectContaining({ ts: 120_000, drivers: ["2"], data: { type: "time", seconds: 10, reason: "CAUSING A COLLISION" } }),
    ]); // la sanción cumplida no es una sanción nueva
    expect(ev.filter((e) => e.kind === "investigation").map((e) => [e.drivers[0], e.data.status])).toEqual([
      ["2", "investigation"],
      ["1", "noted"],
    ]);
  });

  it("práctica y clasificación no generan sobrepasos: el orden cambia por tiempos, no por pasadas", () => {
    for (const type of ["Qualifying", "Practice"] as const) {
      const r = started(3, 10, type);
      r.at(300_000).pass("3", "2"); // bien después de la ventana de largada
      r.at(400_000).pass("3", "1");
      const out = run(r);
      expect(out.isRace).toBe(false);
      expect(out.changes).toHaveLength(0);
      expect(out.events.filter((e) => ["overtake", "leadChange", "start"].includes(e.kind))).toHaveLength(0);
    }
  });
});

describe("compuerta de spoilers", () => {
  const r = started(4, 10);
  r.at(100_000).lap("1", 90_000).lap("2", 90_800).lap("3", 91_600).lap("4", 92_400);
  r.at(150_000).pass("3", "2");
  r.at(180_000).retire("4");
  r.at(200_000).safetyCar();
  r.at(260_000).pass("3", "1");
  r.at(300_000).penalty("3", { seconds: 5 });
  r.at(400_000).finish();
  const full = run(r);

  it("visible() deja solo lo resuelto hasta ahora, por el ts de resolución", () => {
    const items = [{ ts: 10 }, { ts: 20 }, { ts: 30 }];
    expect(visible(items, 20)).toEqual([{ ts: 10 }, { ts: 20 }]);
    expect(visible(items, 5)).toEqual([]);
    expect(visible([{ at: 3 }, { at: 9 }], 5, (x) => x.at)).toEqual([{ at: 3 }]);
  });

  it("para muchos instantes, nada de lo que se muestra es posterior a `now`", () => {
    for (let now = 0; now <= 450_000; now += 7_500) {
      const view = insightsAt(full, now);
      expect(
        view.events.every((e) => e.ts <= now),
        `eventos en ${now}`,
      ).toBe(true);
      expect(
        view.changes.every((c) => c.ts <= now),
        `cambios en ${now}`,
      ).toBe(true);
      expect(
        view.laps.every((l) => l.endTs <= now),
        `vueltas en ${now}`,
      ).toBe(true);
      expect(
        view.stints.every((s) => s.rows.every((l) => l.endTs <= now)),
        `stints en ${now}`,
      ).toBe(true);
    }
  });

  it("el sobrepaso no se muestra hasta que quedó firme, aunque ya haya pasado", () => {
    const flip = 150_000;
    expect(insightsAt(full, flip + DEBOUNCE - 1).events.some((e) => e.kind === "overtake")).toBe(false);
    expect(insightsAt(full, flip + DEBOUNCE).events.some((e) => e.kind === "overtake")).toBe(true);
  });

  it("el resultado final no se revela antes de la bandera", () => {
    expect(insightsAt(full, 399_000).final).toEqual({});
    expect(insightsAt(full, 399_000).endTs).toBeNull();
    expect(Object.keys(insightsAt(full, 401_000).final)).toHaveLength(4);
  });
});

describe("calidad de datos y propiedades generales", () => {
  it("declara qué aproxima cada fuente", () => {
    const r = started(2);
    expect(run(r, "official").dataQuality).toEqual({ source: "official", hasPositions: false, hasTelemetry: false, approximations: [] });
    const open = run(r, "openf1").dataQuality;
    expect(open.approximations.length).toBeGreaterThan(0);
    expect(open.approximations.join(" ")).toMatch(/Abandonos/);
    expect(run(r, "recording").dataQuality.approximations.join(" ")).toMatch(/Sin posiciones/);
  });

  it("detecta si la sesión trae posiciones y telemetría", () => {
    const msgs = started(2).build();
    const withData: RawMessage[] = [
      ...msgs,
      { topic: "Position", ts: 50_000, data: { 1: [1, 2, 1] } },
      { topic: "CarData", ts: 50_000, data: { 1: [100, 9000, 3, 50, 0] } },
    ];
    const q = buildInsights(withData, { source: "official" }).dataQuality;
    expect(q).toMatchObject({ hasPositions: true, hasTelemetry: true });
  });

  it("es determinista y no modifica los mensajes de entrada", () => {
    const msgs = started(4).build();
    const copy = structuredClone(msgs);
    expect(buildInsights(msgs, { source: "official" })).toEqual(buildInsights(msgs, { source: "official" }));
    expect(msgs).toEqual(copy);
  });

  it("los ids de los eventos son estables y únicos", () => {
    const r = started(3);
    r.at(150_000).pass("2", "1").pass("3", "1");
    const ev = run(r).events;
    expect(new Set(ev.map((e) => e.id)).size).toBe(ev.length);
    expect(ev.map((e) => e.id)).toEqual(run(r).events.map((e) => e.id));
    expect(ev.every((e) => e.id.startsWith(`${e.kind}:${e.ts}:`))).toBe(true);
    expect(ev.every((e) => e.seekTs <= e.ts)).toBe(true);
  });

  it("los parámetros se pueden pisar", () => {
    const r = started(3);
    r.at(60_000).pass("3", "2");
    r.at(61_000).pass("2", "3");
    expect(buildInsights(r.build(), { source: "official" }).changes).toHaveLength(0);
    expect(buildInsights(r.build(), { source: "official", params: { OVERTAKE_DEBOUNCE_MS: 500 } }).changes).toHaveLength(2);
  });
});
