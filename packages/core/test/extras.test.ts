import { describe, expect, it } from "vitest";
import { buildInsights, describe as describeEvent, insightsAt, type RawMessage, StateEngine } from "../src";
import { sampleRace } from "./builders";

const S = 1000;
const wx = (ts: number, data: Record<string, string>): RawMessage => ({ topic: "WeatherData", ts, data });

/** La carrera de ejemplo más clima, radio, campeonato, parrilla y el tiempo parado de la parada del 3. */
function race(extra: RawMessage[] = []): RawMessage[] {
  const base = sampleRace().build();
  for (const m of base) {
    const l = (m.data as any)?.Lines?.["3"];
    if (m.topic === "TimingData" && l?.InPit === false) l.StopDuration = 2.4;
  }
  return [...base, ...extra].sort((a, b) => a.ts - b.ts);
}
const drivers = (msgs: RawMessage[]) => buildInsights(msgs, { source: "openf1" });

describe("clima", () => {
  const msgs = race([
    wx(0, {
      AirTemp: "30.0",
      TrackTemp: "44.0",
      Humidity: "70",
      Pressure: "1008.9",
      WindSpeed: "1.5",
      WindDirection: "147",
      Rainfall: "0",
    }),
    wx(120 * S, { TrackTemp: "41.5" }), // mensaje parcial: el resto sigue como estaba
    wx(240 * S, { Rainfall: "1" }),
    wx(400 * S, { Rainfall: "0" }),
  ]);
  const ins = drivers(msgs);

  it("guarda cada lectura y arrastra lo que no viene en el mensaje", () => {
    expect(ins.weather).toHaveLength(4);
    expect(ins.weather[1]).toMatchObject({
      track: 41.5,
      air: 30,
      humidity: 70,
      pressure: 1008.9,
      windSpeed: 1.5,
      windDir: 147,
      rain: false,
    });
    expect(ins.weather[2].rain).toBe(true);
  });

  it("marca cuándo empieza y cuándo deja de llover", () => {
    const rain = ins.events.filter((e) => e.kind === "weather");
    expect(rain.map((e) => [e.ts, e.data.rain])).toEqual([
      [240 * S, true],
      [400 * S, false],
    ]);
    expect(rain.map((e) => describeEvent(e, { drivers: ins.drivers }))).toEqual([
      expect.stringMatching(/Empieza a llover\.$/),
      expect.stringMatching(/Deja de llover\.$/),
    ]);
  });

  it("no inventa lluvia por la primera lectura", () => {
    expect(drivers(race([wx(0, { Rainfall: "0" })])).events.filter((e) => e.kind === "weather")).toEqual([]);
  });

  it("la compuerta: lo que todavía no pasó no se ve", () => {
    const at = insightsAt(ins, 250 * S);
    expect(at.weather).toHaveLength(3);
    expect(at.events.filter((e) => e.kind === "weather")).toHaveLength(1);
  });
});

describe("radio", () => {
  const ins = drivers(
    race([
      { topic: "TeamRadio", ts: 100 * S, data: { Capture: { Utc: "x", RacingNumber: "2", Url: "https://ejemplo.test/a.mp3" } } },
      { topic: "TeamRadio", ts: 300 * S, data: { Capture: { Utc: "y", RacingNumber: "1", Url: "https://ejemplo.test/b.mp3" } } },
      { topic: "TeamRadio", ts: 310 * S, data: { Capture: { RacingNumber: "9" } } }, // sin audio: se descarta
    ]),
  );

  it("guarda los mensajes con audio, en orden", () => {
    expect(ins.radio.map((c) => [c.ts, c.driver, c.url])).toEqual([
      [100 * S, "2", "https://ejemplo.test/a.mp3"],
      [300 * S, "1", "https://ejemplo.test/b.mp3"],
    ]);
  });

  it("solo se oyen los que ya pasaron", () => {
    expect(insightsAt(ins, 200 * S).radio.map((c) => c.driver)).toEqual(["2"]);
    expect(insightsAt(ins, 50 * S).radio).toEqual([]);
  });
});

describe("campeonato", () => {
  const champ: RawMessage = {
    topic: "Championship",
    ts: 500 * S,
    data: {
      Drivers: [
        { driver: "2", posStart: 2, pos: 1, ptsStart: 236, pts: 261 },
        { driver: "1", posStart: 1, pos: 2, ptsStart: 240, pts: 250 },
      ],
      Teams: [{ team: "Equipo 1", posStart: 1, pos: 1, ptsStart: 400, pts: 430 }],
    },
  };
  const ins = drivers(race([champ]));

  it("se lee tal cual", () => {
    expect(ins.championship?.drivers[0]).toEqual({ driver: "2", posStart: 2, pos: 1, ptsStart: 236, pts: 261 });
    expect(ins.championship?.teams).toHaveLength(1);
  });

  it("no existe hasta que termina la carrera (delataría el resultado)", () => {
    expect(insightsAt(ins, 499 * S).championship).toBeNull();
    expect(insightsAt(ins, 500 * S).championship).not.toBeNull();
  });

  it("sin el dato, queda en null", () => {
    expect(drivers(race()).championship).toBeNull();
  });
});

describe("parrilla oficial y tiempo parado", () => {
  const grid: RawMessage = {
    topic: "TimingAppData",
    ts: 0,
    data: { Lines: { "1": { GridPos: "3" }, "2": { GridPos: "1" }, "4": { GridPos: "0" } } },
  };
  const ins = drivers(race([grid]));

  it("lee GridPos y descarta lo que no es un puesto", () => {
    // El generador de carreras ya trae una parrilla; la del test la pisa para los pilotos 1 y 2.
    expect(ins.officialGrid["1"]).toBe(3);
    expect(ins.officialGrid["2"]).toBe(1);
    expect(ins.officialGrid["4"]).not.toBe(0);
    expect(Object.values(ins.officialGrid).every((g) => g > 0)).toBe(true);
  });

  it("el motor la muestra en la fila del piloto y la presión del clima", () => {
    const e = new StateEngine();
    for (const m of race([grid, wx(0, { Pressure: "1008.9", AirTemp: "30" })])) if (m.ts <= 5 * S) e.apply(m);
    const snap = e.snapshot(5 * S);
    expect(snap.drivers.find((d) => d.num === "1")?.grid).toBe(3);
    expect(snap.weather?.pressure).toBe(1008.9);
  });

  it("la parada lleva el tiempo parado y la crónica lo cuenta", () => {
    const pit = ins.events.find((e) => e.kind === "pit" && e.drivers[0] === "3");
    expect(pit?.data.stopSec).toBe(2.4);
    expect(describeEvent(pit!, { drivers: ins.drivers })).toMatch(/\(2,4 s parado, 2\d,\d s en la calle de boxes\)\.$/);
  });

  it("sin tiempo parado en la fuente, queda en null y la crónica no lo menciona", () => {
    const plain = buildInsights(sampleRace().build(), { source: "openf1" });
    const pit = plain.events.find((e) => e.kind === "pit");
    expect(pit?.data.stopSec).toBeNull();
    expect(describeEvent(pit!, { drivers: plain.drivers })).not.toContain("parado");
  });
});
