import { describe, expect, it } from "vitest";
import { activeBattles, buildInsights, insightsAt, PARAMS, paceOfStint, paceStints, projections, type SessionInsights } from "../src";
import { RaceBuilder, type SimOptions, simulate } from "./builders";

const P = { ...PARAMS };
const T0 = 10_000;

/** Una carrera simulada de `drivers` pilotos que ya largó. */
function race(drivers: number, opts: SimOptions & { laps: number }, pitLossSec?: number): SessionInsights {
  const r = new RaceBuilder({ drivers, laps: opts.laps });
  r.at(T0).start();
  simulate(r, opts);
  r.after(60_000).finish();
  return buildInsights(r.build(), { source: "official", pitLossSec });
}

const strategy = (ins: SessionInsights) => ins.events.filter((e) => e.kind === "undercut" || e.kind === "overcut");

/** Desgaste de neumáticos: cada vuelta con el mismo juego cuesta `deg` ms más. */
const degrade =
  (deg: number, extra?: (num: string, lap: number, age: number, out: boolean) => number): NonNullable<SimOptions["lapMs"]> =>
  (num, lap, age, out) =>
    90_000 + deg * age + (extra?.(num, lap, age, out) ?? 0);

describe("undercut y overcut", () => {
  it("el que para primero y sale adelante hace un undercut exitoso", () => {
    // 2 va 1,5 s detrás de 1 y para dos vueltas antes: con 0,3 s de desgaste por vuelta, sus neumáticos nuevos le ganan
    // ~4,8 s mientras 1 sigue con los viejos, y todavía queda delante cuando se asientan las dos vueltas siguientes.
    const ins = race(2, {
      laps: 18,
      startGapMs: 1500,
      lapMs: degrade(300),
      pits: { "2": [{ lap: 8 }], "1": [{ lap: 10 }] },
    });
    const [e] = strategy(ins);
    expect(strategy(ins)).toHaveLength(1);
    expect(e).toMatchObject({ kind: "undercut", drivers: ["2", "1"], lap: 8, data: { success: true, lapsBetween: 2, firstToStop: "2" } });
    expect(e.data.gainSec).toBeGreaterThan(2);
    expect(e.data.gainSec).toBeLessThan(4.5);
    // queda resuelto después de las dos paradas y tres vueltas más
    const pits = ins.events.filter((x) => x.kind === "pit");
    expect(e.ts).toBeGreaterThan(Math.max(...pits.map((p) => p.ts)));
    expect(e.seekTs).toBeLessThan(pits[0].ts);
  });

  it("si la ventaja no alcanza, el undercut falla", () => {
    const ins = race(2, { laps: 18, startGapMs: 1500, lapMs: degrade(30), pits: { "2": [{ lap: 8 }], "1": [{ lap: 10 }] } });
    expect(strategy(ins)).toEqual([
      expect.objectContaining({ kind: "undercut", drivers: ["2", "1"], data: expect.objectContaining({ success: false }) }),
    ]);
    expect(strategy(ins)[0].data.gainSec).toBeGreaterThan(0); // recorta, pero el otro sigue delante
  });

  it("el que se queda afuera y sale adelante hace un overcut", () => {
    // 1 va 1 s delante y para primero; 2 alarga y marca vueltas rápidas mientras 1 está con neumáticos fríos.
    const ins = race(2, {
      laps: 18,
      startGapMs: 1000,
      lapMs: degrade(
        100,
        (num, lap, age) => (num === "1" && lap > 8 && age <= 3 ? 2500 : 0) + (num === "2" && (lap === 9 || lap === 10) ? -1800 : 0),
      ),
      pits: { "1": [{ lap: 8 }], "2": [{ lap: 11 }] },
    });
    expect(strategy(ins)).toEqual([
      expect.objectContaining({ kind: "overcut", drivers: ["2", "1"], lap: 8, data: expect.objectContaining({ success: true }) }),
    ]);
  });

  it("si el que iba delante sigue delante, no hay evento", () => {
    const ins = race(2, { laps: 18, startGapMs: 1000, lapMs: degrade(100), pits: { "1": [{ lap: 8 }], "2": [{ lap: 10 }] } });
    expect(strategy(ins)).toHaveLength(0);
  });

  it("se descarta si hay Safety Car entre las dos paradas", () => {
    const ins = race(2, {
      laps: 18,
      startGapMs: 1500,
      lapMs: degrade(150),
      pits: { "2": [{ lap: 8 }], "1": [{ lap: 10 }] },
      safetyCar: { from: 8, to: 9 },
    });
    expect(ins.laps.some((l) => l.neutralized)).toBe(true);
    expect(strategy(ins)).toHaveLength(0);
  });

  it("se descarta si uno de los dos se retira antes de que se pueda medir", () => {
    const ins = race(2, {
      laps: 18,
      startGapMs: 1500,
      lapMs: degrade(150),
      pits: { "2": [{ lap: 8 }], "1": [{ lap: 10 }] },
      retire: { "1": 11 },
    });
    expect(strategy(ins)).toHaveLength(0);
  });

  it("se descarta si el rival está más lejos de lo que cuesta una parada", () => {
    const ins = race(2, { laps: 18, startGapMs: 40_000, lapMs: degrade(150), pits: { "2": [{ lap: 8 }], "1": [{ lap: 10 }] } });
    expect(strategy(ins)).toHaveLength(0);
  });

  it("se descarta si el rival para fuera de la ventana de respuesta", () => {
    const ins = race(2, {
      laps: 24,
      startGapMs: 1500,
      lapMs: degrade(150),
      pits: { "2": [{ lap: 5 }], "1": [{ lap: 5 + PARAMS.UNDERCUT_MAX_LAPS + 2 }] },
    });
    expect(strategy(ins)).toHaveLength(0);
  });

  it("el costo de parada se estima con la propia sesión y se rotula como aproximado; si se informa, es exacto", () => {
    const sim: SimOptions & { laps: number } = {
      laps: 18,
      startGapMs: 1500,
      lapMs: degrade(150),
      pits: { "2": [{ lap: 8 }], "1": [{ lap: 10 }] },
      pitLossMs: 22_000,
    };
    const est = race(2, sim);
    expect(est.pitLossSec.estimated).toBe(true);
    expect(est.pitLossSec.value).toBeGreaterThan(20);
    expect(est.pitLossSec.value).toBeLessThan(26);
    expect(strategy(est)[0].confidence).toBe("approx");
    const exact = race(2, sim, 22);
    expect(exact.pitLossSec).toEqual({ value: 22, estimated: false });
    expect(strategy(exact)[0]).toMatchObject({ confidence: "high", data: { pitLossSec: 22 } });
  });

  it("no aplica fuera de la carrera", () => {
    const r = new RaceBuilder({ drivers: 2, laps: 10, type: "Practice" });
    r.at(T0).start();
    simulate(r, { laps: 8, pits: { "1": [{ lap: 4 }] } });
    expect(strategy(buildInsights(r.build(), { source: "official" }))).toHaveLength(0);
  });
});

describe("ritmo por stint", () => {
  const ins = race(2, {
    laps: 30,
    lapMs: degrade(120, (num, lap) => (num === "1" && lap === 7 ? 3500 : 0)), // una vuelta con tráfico
    pits: { "1": [{ lap: 18, compound: "HARD" }] },
  });
  const stint = (d: string, i: number) => ins.stints.find((s) => s.driver === d && s.index === i)!;

  it("recupera la pendiente sembrada (0,12 s por vuelta) con R² alto", () => {
    const p = paceOfStint(stint("2", 0), P)!;
    expect(p.slope).toBeCloseTo(0.12, 3);
    expect(p.r2).toBeGreaterThan(0.99);
    expect(p.compound).toBe("MEDIUM");
  });

  it("descarta la vuelta con tráfico, la 1, la de entrada y la de salida de boxes", () => {
    const p = paceOfStint(stint("1", 0), P)!;
    expect(p.slope).toBeCloseTo(0.12, 3); // con la vuelta de +3,5 s la pendiente se corrompería
    expect(p.n).toBe(15); // 17 vueltas del stint − la 1 − la de entrada − la del tráfico
    const outStint = paceOfStint(stint("1", 1), P)!;
    expect(outStint.points[0].age).toBe(2); // la vuelta de salida (edad 1) no cuenta
    expect(outStint.slope).toBeCloseTo(0.12, 3);
  });

  it("los puntos van relativos a la primera vuelta limpia", () => {
    const p = paceOfStint(stint("2", 0), P)!;
    expect(p.points[0]).toEqual({ age: p.points[0].age, rel: 0 });
    expect(p.points[4].rel).toBeCloseTo(0.48, 2);
  });

  it("no calcula con menos de MIN_STINT_LAPS vueltas limpias", () => {
    const short = race(2, { laps: 5, lapMs: degrade(120) }); // vueltas 2 a 5: solo 4 limpias
    expect(paceOfStint(short.stints[0], P)).toBeNull();
    expect(paceOfStint(stint("2", 0), { ...P, MIN_STINT_LAPS: 100 })).toBeNull();
  });

  it("deja afuera las vueltas con bandera amarilla o Safety Car", () => {
    const sc = race(2, { laps: 30, lapMs: degrade(120), safetyCar: { from: 12, to: 14 } });
    const all = paceOfStint(sc.stints.find((s) => s.driver === "2")!, P)!;
    const neutral = sc.laps.filter((l) => l.driver === "2" && l.neutralized).length;
    expect(neutral).toBeGreaterThan(0);
    expect(all.n).toBe(29 - neutral); // todas menos la 1 y las neutralizadas
  });

  it("solo usa las vueltas que ya ocurrieron", () => {
    const now = stint("2", 0).rows[11].endTs; // hasta la vuelta 12
    const view = insightsAt(ins, now);
    const p = paceStints(view.stints, P).find((x) => x.driver === "2")!;
    expect(p.n).toBe(11); // vueltas 2 a 12
    expect(paceStints(ins.stints, P).find((x) => x.driver === "2" && x.stint === 0)!.n).toBe(29);
  });
});

describe("duelos", () => {
  const events = (ins: SessionInsights) => ins.events.filter((e) => e.kind === "battle");

  it("se declara tras BATTLE_MIN_LAPS vueltas seguidas a menos de 1 s, y no antes", () => {
    const ins = race(2, { laps: 10, startGapMs: 700, base: { "1": 90_000, "2": 90_000 }, lapMs: () => 90_000 });
    expect(ins.battles).toHaveLength(1);
    const b = ins.battles[0];
    expect(b).toMatchObject({ chaser: "2", ahead: "1", declaredLap: 1 + PARAMS.BATTLE_MIN_LAPS, result: "open", endTs: null });
    expect(events(ins)).toHaveLength(1);
    expect(events(ins)[0]).toMatchObject({ drivers: ["2", "1"], lap: b.declaredLap, data: { phase: "start", laps: 3 } });
    expect(events(ins)[0].ts).toBe(b.startTs);
  });

  it("la vuelta 1 no cuenta: los intervalos son los de la grilla", () => {
    const ins = race(2, { laps: 10, startGapMs: 700, lapMs: () => 90_000 });
    expect(ins.battles[0].fromLap).toBe(2);
  });

  it("termina cuando el de atrás se aleja, y si el orden no cambió, aguantó", () => {
    const ins = race(2, {
      laps: 14,
      startGapMs: 700,
      lapMs: (num, lap) => (num === "2" && lap >= 6 ? 91_000 : 90_000), // desde la 6, el de atrás pierde 1 s por vuelta
    });
    const b = ins.battles[0];
    expect(b.result).toBe("held");
    expect(b.endLap).toBeGreaterThan(b.declaredLap);
    expect(events(ins).map((e) => e.data.phase)).toEqual(["start", "end"]);
    expect(events(ins)[1].data).toMatchObject({ phase: "end", result: "held" });
  });

  it("si el de atrás pasa durante el duelo, el resultado es 'passed'", () => {
    const ins = race(2, {
      laps: 16,
      startGapMs: 700,
      lapMs: (num, lap) => (num === "2" ? (lap >= 3 ? 89_500 : 90_000) : 90_000),
    });
    expect(ins.battles[0]).toMatchObject({ chaser: "2", ahead: "1", result: "passed" });
  });

  it("una parada interrumpe el duelo", () => {
    const ins = race(2, { laps: 14, startGapMs: 700, lapMs: () => 90_000, pits: { "2": [{ lap: 6 }] } });
    expect(ins.battles[0].result).toBe("held");
    expect(ins.battles[0].endLap).toBeLessThanOrEqual(9);
  });

  it("los duelos en curso se consultan por instante", () => {
    const ins = race(2, { laps: 10, startGapMs: 700, lapMs: () => 90_000 });
    const b = ins.battles[0];
    expect(activeBattles(ins.battles, b.startTs - 1)).toHaveLength(0);
    expect(activeBattles(ins.battles, b.startTs)).toHaveLength(1);
  });

  it("autos separados por más de 1 s no tienen duelo", () => {
    expect(race(2, { laps: 10, startGapMs: 2500, lapMs: () => 90_000 }).battles).toHaveLength(0);
  });
});

describe("proyección: lo alcanza en N vueltas", () => {
  /** el 2 viene 0,5 s por vuelta más rápido que el 1 y largó 6 s detrás */
  const ins = race(2, { laps: 20, startGapMs: 6000, lapMs: (num) => (num === "1" ? 90_000 : 89_500) });
  const at = (lap: number) => ins.laps.filter((l) => l.lap <= lap);

  it("proyecta con el cierre real y el intervalo actual", () => {
    const rows = at(6);
    const gap = rows.filter((l) => l.driver === "2").at(-1)!.intervalSec!;
    const [p] = projections(rows, P, 14);
    expect(p).toMatchObject({ chaser: "2", ahead: "1" });
    expect(p.closing).toBeCloseTo(0.5, 2);
    expect(p.laps).toBeCloseTo((gap - PARAMS.BATTLE_GAP_SEC) / 0.5, 2);
  });

  it("solo si cabe en las vueltas que quedan", () => {
    expect(projections(at(6), P, 14)).toHaveLength(1);
    expect(projections(at(6), P, 1)).toHaveLength(0);
    expect(projections(at(6), P, null)).toHaveLength(1);
  });

  it("no proyecta si todavía no hay suficientes vueltas limpias, ni si ya están en duelo", () => {
    expect(projections(at(3), P, 17)).toHaveLength(0);
    const gap = at(10)
      .filter((l) => l.driver === "2")
      .at(-1)!.intervalSec!;
    expect(gap).toBeLessThanOrEqual(PARAMS.BATTLE_GAP_SEC + 0.01);
    expect(projections(at(10), P, 10)).toHaveLength(0);
  });

  it("no proyecta si el cierre es menor al mínimo", () => {
    const slow = race(2, { laps: 20, startGapMs: 6000, lapMs: (num) => (num === "1" ? 90_000 : 89_900) });
    expect(
      projections(
        slow.laps.filter((l) => l.lap <= 8),
        P,
        12,
      ),
    ).toHaveLength(0);
  });

  it("desaparece si hay una parada en la ventana de ritmo", () => {
    const stop = race(2, { laps: 20, startGapMs: 12_000, lapMs: (num) => (num === "1" ? 90_000 : 89_500), pits: { "1": [{ lap: 6 }] } });
    const upTo = (lap: number) => stop.laps.filter((l) => l.lap <= lap);
    expect(projections(upTo(5), P, null).length).toBeGreaterThan(0);
    expect(projections(upTo(7), P, null)).toHaveLength(0); // la 6 es de entrada y la 7 de salida
  });

  it("desaparece con una neutralización en la ventana", () => {
    const sc = race(2, { laps: 20, startGapMs: 12_000, lapMs: (num) => (num === "1" ? 90_000 : 89_500), safetyCar: { from: 6, to: 7 } });
    expect(
      projections(
        sc.laps.filter((l) => l.lap <= 8),
        P,
        12,
      ),
    ).toHaveLength(0);
  });
});
