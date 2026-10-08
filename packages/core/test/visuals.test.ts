import { describe, expect, it } from "vitest";
import { dominance, idealLaps, type LapRow, PARAMS, type TelemetryLap, topSpeeds } from "../src";

/** Una vuelta de telemetría sintética de 101 puntos: los tiempos salen de la duración de cada quinto del circuito. */
function lap(d: string, n: number, fifths: [number, number, number, number, number], speedPeak = 300): TelemetryLap {
  const grid = 101;
  const t: number[] = [];
  let acc = 0;
  for (let i = 0; i < grid; i++) {
    t.push(Math.round(acc));
    const seg = Math.min(4, Math.floor(i / 20));
    acc += fifths[seg] / 20;
  }
  const ms = t[grid - 1];
  return {
    d,
    n,
    s: 0,
    e: ms,
    ms,
    kind: "flying",
    part: null,
    tyre: "SOFT",
    age: 1,
    t,
    v: t.map((_, i) => (i === 37 ? speedPeak : 200)),
    th: t.map(() => 100),
    br: t.map(() => 0),
    g: t.map(() => 7),
    r: t.map(() => 10_000),
  };
}

describe("mapa de dominio por tramos", () => {
  // 1 es mejor en el primer y tercer quinto; 2, en el segundo y el cuarto; el quinto, igual.
  const a = lap("1", 5, [18_000, 20_000, 17_000, 19_000, 16_000]);
  const b = lap("2", 7, [18_500, 19_000, 17_800, 18_200, 16_010]);

  it("elige al ganador de cada tramo y mide por cuánto", () => {
    const seg = dominance({ "1": a, "2": b }, 5, PARAMS.DOMINANCE_TIE_MS);
    expect(seg).toHaveLength(5);
    expect(seg.map((s) => s.winner)).toEqual(["1", "2", "1", "2", null]);
    expect(seg[0]).toMatchObject({ from: 0, to: 0.2, marginMs: 500 });
    expect(seg[1].marginMs).toBe(1000);
    expect(seg[0].times).toEqual({ "1": 18_000, "2": 18_500 });
  });

  it("los tramos son consecutivos y cubren todo el circuito", () => {
    const seg = dominance({ "1": a, "2": b }, 25, PARAMS.DOMINANCE_TIE_MS);
    expect(seg).toHaveLength(25);
    expect(seg[0].from).toBe(0);
    expect(seg[24].to).toBe(1);
    for (let i = 1; i < seg.length; i++) expect(seg[i].from).toBeCloseTo(seg[i - 1].to, 10);
    // la suma de los tramos de cada piloto es su tiempo de vuelta
    const total = (d: string) => seg.reduce((acc, s) => acc + s.times[d], 0);
    expect(total("1")).toBeCloseTo(a.ms, 0);
    expect(total("2")).toBeCloseTo(b.ms, 0);
  });

  it("con el umbral de empate, las diferencias chicas no eligen ganador", () => {
    const seg = dominance({ "1": a, "2": b }, 5, 600);
    expect(seg.map((s) => s.winner)).toEqual([null, "2", "1", "2", null]);
  });

  it("compara hasta cuatro pilotos y necesita al menos dos", () => {
    const c = lap("3", 4, [17_000, 21_000, 18_000, 20_000, 16_500]);
    const seg = dominance({ "1": a, "2": b, "3": c }, 5, 30);
    expect(seg.map((s) => s.winner)).toEqual(["3", "2", "1", "2", null]); // en el último, 1 y 2 empatan por 10 ms
    expect(dominance({ "1": a }, 5, 30)).toEqual([]);
  });
});

describe("vuelta ideal", () => {
  const row = (driver: string, lapN: number, sectors: [number | null, number | null, number | null], lapTimeMs: number | null): LapRow => ({
    driver,
    lap: lapN,
    startTs: 0,
    endTs: lapN * 100_000,
    lapTimeMs,
    position: null,
    gapLeaderSec: null,
    intervalSec: null,
    tyre: null,
    stint: 0,
    inLap: false,
    outLap: false,
    neutralized: false,
    yellow: false,
    sectorsMs: sectors,
  });

  it("combina los mejores sectores de vueltas distintas y dice qué dejó en la mesa", () => {
    const rows = [
      row("1", 3, [30_000, 40_000, 20_500], 90_500), // mejor vuelta real
      row("1", 4, [29_800, 41_000, 20_900], 91_700),
      row("1", 5, [30_300, 39_700, 21_000], 91_000),
    ];
    const [r] = idealLaps(rows);
    expect(r).toMatchObject({ driver: "1", bestMs: 90_500, sectors: [29_800, 39_700, 20_500], idealMs: 90_000, lossMs: 500 });
    // la mejor vuelta (90,5) se aleja más en el sector 2: 40,0 contra 39,7... y en el 1: 30,0 contra 29,8
    expect(r.limiting).toBe(1);
  });

  it("sin los tres sectores no hay vuelta ideal", () => {
    const [r] = idealLaps([row("1", 3, [30_000, 40_000, null], 90_500), row("1", 4, [29_000, null, null], null)]);
    expect(r.idealMs).toBeNull();
    expect(r.lossMs).toBeNull();
    expect(r.limiting).toBeNull();
    expect(r.sectors).toEqual([29_000, 40_000, null]);
    expect(r.bestMs).toBe(90_500);
  });

  it("ordena por vuelta ideal", () => {
    const rows = [
      row("1", 3, [30_000, 40_000, 20_000], 91_000),
      row("2", 3, [29_000, 39_000, 20_000], 89_000),
      row("3", 3, [31_000, 41_000, 20_000], null),
    ];
    expect(idealLaps(rows).map((r) => r.driver)).toEqual(["2", "1", "3"]);
  });

  it("un piloto con una sola vuelta tiene ideal igual a su vuelta", () => {
    const [r] = idealLaps([row("1", 3, [30_000, 40_000, 20_000], 90_000)]);
    expect(r).toMatchObject({ idealMs: 90_000, lossMs: 0, limiting: null });
  });
});

describe("velocidades máximas", () => {
  it("la mejor de cada piloto, de mayor a menor, con la vuelta y dónde", () => {
    const laps = [
      lap("1", 3, [18_000, 20_000, 17_000, 19_000, 16_000], 322),
      lap("1", 4, [18_000, 20_000, 17_000, 19_000, 16_000], 330),
      lap("2", 3, [18_000, 20_000, 17_000, 19_000, 16_000], 318),
    ];
    const top = topSpeeds(laps, 6000);
    expect(top.map((t) => [t.driver, t.kmh, t.lap])).toEqual([
      ["1", 330, 4],
      ["2", 318, 3],
    ]);
    expect(top[0].atM).toBe(Math.round((37 / 100) * 6000));
  });
});
