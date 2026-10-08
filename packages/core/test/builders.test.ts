import { describe, expect, it } from "vitest";
import { type RawMessage, StateEngine } from "../src";
import { RaceBuilder, sampleRace, syntheticDrivers } from "./builders";
import schema from "./schema.json";

type Schema = { topics: Record<string, Record<string, string[]>> };
const real = schema as unknown as Schema;

/** Rutas y tipos de un valor, con los números normalizados a `*` (igual que scripts/fixture-schema.ts). */
function shapeOf(value: unknown, prefix = "$", out: [string, string][] = []): [string, string][] {
  out.push([prefix, value === null ? "null" : Array.isArray(value) ? "array" : typeof value]);
  if (Array.isArray(value)) for (const v of value) shapeOf(v, `${prefix}.*`, out);
  else if (value && typeof value === "object")
    for (const [k, v] of Object.entries(value)) shapeOf(v, `${prefix}.${/^\d+$/.test(k) ? "*" : k}`, out);
  return out;
}

/** Lo que el builder emite y el feed real nunca emitió. Lista vacía = la forma es fiel. */
function unknownShapes(messages: RawMessage[]): string[] {
  const bad = new Set<string>();
  for (const m of messages) {
    const known = real.topics[m.topic];
    if (!known) {
      bad.add(`topic ${m.topic}`);
      continue;
    }
    for (const [path, type] of shapeOf(m.data)) {
      if (!known[path]?.includes(type)) bad.add(`${m.topic} ${path} (${type})`);
    }
  }
  return [...bad].sort();
}

describe("constructor de escenarios: forma fiel al feed", () => {
  it("los mensajes de una carrera completa solo usan rutas y tipos que existen en datos reales", () => {
    expect(unknownShapes(sampleRace().build())).toEqual([]);
  });

  it("también los de Safety Car virtual, bandera roja, amarillas, gaps de doblados y decisiones de los comisarios", () => {
    const r = new RaceBuilder({ drivers: 4, laps: 5 });
    r.at(1000).start();
    r.at(5000).safetyCar("VSC").allClear().safetyCar("SC").redFlag().allClear();
    r.at(6000).yellow(3).yellow(3, true);
    r.at(7000).gap("3", { gap: "1L", interval: "1L" }).gap("4", { gap: 25.5, interval: 3.2 });
    r.at(8000).penalty("1", { kind: "drive-through", reason: "YELLOW FLAG INFRINGEMENT" }).penalty("2", { kind: "stop-go" });
    r.at(9000)
      .steward("3", "NOTED", "CAUSING A COLLISION")
      .steward("3", "UNDER INVESTIGATION")
      .steward("3", "REVIEWED NO FURTHER INVESTIGATION");
    r.at(10_000).steward("4", "WILL BE INVESTIGATED AFTER THE RACE").finish();
    expect(unknownShapes(r.build())).toEqual([]);
  });

  it("el detector de formas funciona: una clave inventada se detecta", () => {
    const bad: RawMessage[] = [{ topic: "TimingData", ts: 0, data: { Lines: { 1: { InventedField: true, Position: 3 } } } }];
    expect(unknownShapes(bad)).toEqual(["TimingData $.Lines.*.InventedField (boolean)", "TimingData $.Lines.*.Position (number)"]);
  });

  it("los mensajes de Race Control: el primero llega como array y los siguientes como objeto con índice", () => {
    const rc = sampleRace()
      .build()
      .filter((m) => m.topic === "RaceControlMessages");
    expect(Array.isArray((rc[0].data as { Messages: unknown }).Messages)).toBe(true);
    expect(Object.keys((rc[1].data as { Messages: object }).Messages)).toEqual(["1"]);
  });

  it("los pilotos son inventados: siglas AAA, BBB… y ningún nombre real", () => {
    const ds = syntheticDrivers(22);
    expect(ds.map((d) => d.tla).slice(0, 3)).toEqual(["AAA", "BBB", "CCC"]);
    expect(new Set(ds.map((d) => d.num)).size).toBe(22);
    expect(ds[0].name).toBe("Piloto A");
  });
});

describe("constructor de escenarios: el motor los entiende", () => {
  const messages = sampleRace().build();
  const stateAt = (ts: number) => {
    const engine = new StateEngine();
    for (const m of messages) if (m.ts <= ts) engine.apply(m);
    return engine.snapshot(ts);
  };
  const by = (s: ReturnType<typeof stateAt>, num: string) => s.drivers.find((d) => d.num === num)!;

  it("mensajes ordenados por ts, con Heartbeat cada 15 s", () => {
    expect(messages.every((m, i) => i === 0 || m.ts >= messages[i - 1].ts)).toBe(true);
    const beats = messages.filter((m) => m.topic === "Heartbeat");
    expect(beats.length).toBeGreaterThan(10);
    expect(beats[1].ts - beats[0].ts).toBeLessThanOrEqual(15_000);
  });

  it("antes de la largada: grilla, sesión sin iniciar y 5 pilotos", () => {
    const s = stateAt(5_000);
    expect(s.status).toBe("Inactive");
    expect(s.session).toMatchObject({ meeting: "Gran Premio de Prueba", name: "Race", type: "Race" });
    expect(s.drivers.map((d) => d.tla)).toEqual(["AAA", "BBB", "CCC", "DDD", "EEE"]);
    expect(s.lap).toEqual({ current: 1, total: 6 });
    expect(by(s, "1").tyre).toMatchObject({ compound: "MEDIUM", age: 0 });
  });

  it("al cerrar la primera vuelta: tiempos, banderas de mejor vuelta, gaps y contador de vueltas", () => {
    const s = stateAt(110_000 + 5_000);
    expect(s.status).toBe("Started");
    expect(s.lap).toEqual({ current: 2, total: 6 });
    const a = by(s, "1");
    expect(a.laps).toBe(1);
    expect(a.lastLap).toMatchObject({ value: "1:36.000", pb: true, ob: true });
    expect(a.bestLap).toBe("1:36.000");
    expect(a.sectors.map((x) => x.value)).toEqual(["32.640", "39.360", "24.000"]);
    expect(by(s, "2").lastLap).toMatchObject({ value: "1:36.800", pb: true, ob: false });
    expect(by(s, "2")).toMatchObject({ gap: "+0.800", interval: "+0.800" });
    expect(by(s, "3")).toMatchObject({ gap: "+1.600", interval: "+0.800" });
    expect(s.raceControl.map((m) => m.message)).toEqual(["RACE START"]);
  });

  it("un sobrepaso llega como un mensaje con dos cambios y reordena la torre", () => {
    const before = stateAt(150_000);
    expect(before.drivers.map((d) => d.tla)).toEqual(["AAA", "BBB", "CCC", "DDD", "EEE"]);
    const after = stateAt(165_000);
    expect(after.drivers.map((d) => d.tla)).toEqual(["BBB", "AAA", "CCC", "DDD", "EEE"]);
    const swap = messages.find((m) => m.ts === 160_000 && m.topic === "TimingData")!;
    expect(Object.keys((swap.data as { Lines: object }).Lines)).toHaveLength(2);
  });

  it("una parada: entra a boxes, sale con duros nuevos y PitOut se apaga solo", () => {
    expect(by(stateAt(268_500), "3")).toMatchObject({ inPit: true, pits: 1 });
    const out = by(stateAt(291_000), "3");
    expect(out).toMatchObject({ inPit: false, pitOut: true, pits: 1 });
    expect(out.tyre).toMatchObject({ compound: "HARD", isNew: true, age: 0 });
    expect(by(stateAt(340_000), "3").pitOut).toBe(false);
  });

  it("Safety Car y retiro: estado de pista y piloto parado", () => {
    const s = stateAt(336_000);
    expect(s.track).toEqual({ status: "4", message: "SCDeployed" });
    expect(by(s, "5")).toMatchObject({ retired: true, stopped: true });
    expect(s.raceControl.at(-1)).toMatchObject({ category: "SafetyCar", message: "SAFETY CAR DEPLOYED" });
    expect(stateAt(461_000).track.status).toBe("1");
  });

  it("la sanción se anuncia en Race Control con el piloto solo en el texto", () => {
    const pen = stateAt(470_000).raceControl.find((m) => m.message.includes("TIME PENALTY"))!;
    expect(pen.message).toBe("FIA STEWARDS: 5 SECOND TIME PENALTY FOR CAR 4 (DDD) - SPEEDING IN THE PIT LANE");
    expect(pen.driver).toBeNull();
  });

  it("la bandera a cuadros cierra la sesión", () => {
    const s = stateAt(560_000);
    expect(s.status).toBe("Finished");
    expect(s.raceControl.at(-1)?.flag).toBe("CHEQUERED");
    expect(stateAt(1_200_000).status).toBe("Finalised");
  });
});

describe("constructor de escenarios: protecciones contra mal uso", () => {
  it("el cursor no retrocede", () => {
    expect(() => new RaceBuilder().at(5000).at(4000)).toThrow(/retroceder/);
  });

  it("pilotos desconocidos, sobrepasos no adyacentes y doble largada se rechazan", () => {
    const r = new RaceBuilder({ drivers: 4 });
    expect(() => r.lap("99", 90_000)).toThrow(/desconocido/);
    expect(() => r.pass("3", "1")).toThrow(/justo delante/);
    expect(() => r.pass("1", "2")).toThrow(/justo delante/); // 1 ya va delante de 2
    r.start();
    expect(() => r.start()).toThrow(/ya largó/);
    r.finish();
    expect(() => r.finish()).toThrow(/ya terminó/);
  });

  it("order() exige a todos los pilotos, una vez cada uno", () => {
    const r = new RaceBuilder({ drivers: 3 });
    expect(() => r.order(["1", "2"])).toThrow(/todos los pilotos/);
    expect(() => r.order(["1", "1", "2"])).toThrow(/todos los pilotos/);
  });

  it("build() es determinista y devuelve copias: tocar la salida no afecta a la siguiente", () => {
    const r = sampleRace();
    const a = r.build();
    const b = r.build();
    expect(a).toEqual(b);
    (a[0].data as { Utc: string }).Utc = "alterado";
    expect((r.build()[0].data as { Utc: string }).Utc).not.toBe("alterado");
  });
});
