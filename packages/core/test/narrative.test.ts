import { expect, it, describe as suite } from "vitest";
import { buildInsights, type DriverInfo, describe, type InsightEvent, insightsAt, shortName } from "../src";
import { RaceBuilder } from "./builders";

const drivers: Record<string, DriverInfo> = {
  "1": { tla: "AAA", name: "Pepe QUINTANA", team: "Equipo 1", color: "111111" },
  "2": { tla: "BBB", name: "Gabo RIVERA", team: "Equipo 1", color: "222222" },
  "3": { tla: "CCC", name: "Nico DE LA ROSA", team: "Equipo 2", color: "333333" },
};
const ctx = { drivers };

const ev = (kind: InsightEvent["kind"], drivers: string[], data: InsightEvent["data"], lap: number | null = 22): InsightEvent => ({
  id: "x",
  kind,
  ts: 0,
  seekTs: 0,
  lap,
  drivers,
  data,
  confidence: "high",
});

suite("nombres cortos", () => {
  it("toma el apellido en mayúsculas y lo pasa a mayúscula inicial", () => {
    expect(shortName(drivers["1"], "1")).toBe("Quintana");
    expect(shortName(drivers["3"], "3")).toBe("De La Rosa");
    expect(shortName({ tla: "AAA", name: "Piloto A", team: "", color: "" }, "1")).toBe("Piloto A");
    expect(shortName(undefined, "77")).toBe("#77");
  });
});

suite("crónica: una frase por tipo de evento", () => {
  const cases: [string, InsightEvent, string][] = [
    ["sobrepaso", ev("overtake", ["1", "2"], { toPos: 4, afterPits: false }), "V22 · Quintana pasa a Rivera y queda 4.º."],
    ["toma la punta", ev("leadChange", ["2", "1"], { toPos: 1, afterPits: false }), "V22 · Rivera pasa a Quintana y toma la punta."],
    [
      "toma la punta tras las paradas",
      ev("leadChange", ["2", "1"], { toPos: 1, afterPits: true }),
      "V22 · Rivera toma la punta tras las paradas.",
    ],
    [
      "parada",
      ev("pit", ["3"], { laneSec: 21.4, stops: 1, compound: "HARD", rejoinPos: 6 }),
      "V22 · De La Rosa para y monta duros, vuelve 6.º (21,4 s en la calle de boxes).",
    ],
    [
      "parada sin datos de salida",
      ev("pit", ["3"], { laneSec: 25, stops: 2, compound: null, rejoinPos: null }),
      "V22 · De La Rosa para (25,0 s en la calle de boxes).",
    ],
    ["vuelta rápida", ev("fastestLap", ["1"], { lapMs: 104_916, previousMs: 105_200 }, 52), "V52 · Vuelta rápida de Quintana: 1:44.916."],
    ["abandono", ev("retirement", ["2"], { lapsDone: 20 }), "V22 · Rivera abandona."],
    [
      "sanción de tiempo",
      ev("penalty", ["2"], { type: "time", seconds: 5, reason: "SPEEDING IN THE PIT LANE" }),
      "V22 · Sanción para Rivera: 5 segundos de sanción (speeding in the pit lane).",
    ],
    [
      "pasada por boxes",
      ev("penalty", ["2"], { type: "drive-through", seconds: null, reason: null }),
      "V22 · Sanción para Rivera: pasada por boxes.",
    ],
    [
      "incidente anotado",
      ev("investigation", ["1", "2"], { status: "noted", turn: 3, reason: "CAUSING A COLLISION" }),
      "V22 · Incidente anotado: Quintana y Rivera (causing a collision).",
    ],
    [
      "incidente bajo investigación",
      ev("investigation", ["1"], { status: "investigation", turn: null, reason: null }),
      "V22 · Bajo investigación: Quintana.",
    ],
    [
      "incidente al final",
      ev("investigation", ["1", "2", "3"], { status: "after-session", turn: null, reason: null }),
      "V22 · Se investigará al final: Quintana, Rivera y De La Rosa.",
    ],
    [
      "incidente sin sanción",
      ev("investigation", ["3"], { status: "cleared", turn: null, reason: "IGNORING BLUE FLAGS" }),
      "V22 · Sin sanción para De La Rosa (ignoring blue flags).",
    ],
    ["Safety Car", ev("neutralization", [], { type: "SC" }, 40), "V40 · Safety Car."],
    ["Safety Car virtual", ev("neutralization", [], { type: "VSC" }, 40), "V40 · Safety Car virtual."],
    ["bandera roja", ev("neutralization", [], { type: "RED" }, 40), "V40 · Bandera roja."],
    [
      "largada",
      ev("start", ["3", "1"], { gainDriver: "3", gainN: 3, lossDriver: "1", lossN: 2, moved: 8 }, 1),
      "Largada: De La Rosa gana 3 puestos; Quintana pierde 2 puestos.",
    ],
    [
      "largada sin ganadores claros",
      ev("start", ["3"], { gainDriver: "3", gainN: 1, lossDriver: null, lossN: 0, moved: 2 }, 1),
      "Largada: De La Rosa gana 1 puesto.",
    ],
    ["duelo", ev("battle", ["1", "2"], { gapSec: 0.6, laps: 4 }), "V22 · Duelo entre Quintana y Rivera: 0,6 s desde hace 4 vueltas."],
    [
      "undercut",
      ev("undercut", ["1", "2"], { success: true, gainSec: 1.8 }, 31),
      "V31 · Undercut de Quintana sobre Rivera: gana 1,8 s con la parada.",
    ],
    [
      "overcut",
      ev("overcut", ["2", "1"], { success: true, gainSec: 2.3 }, 31),
      "V31 · Overcut de Rivera sobre Quintana: gana 2,3 s alargando el stint.",
    ],
    [
      "undercut que no sale",
      ev("undercut", ["1", "2"], { success: false, gainSec: 0.4 }, 31),
      "V31 · Quintana para primero pero no le saca ventaja a Rivera (0,4 s).",
    ],
    ["sin vuelta conocida", ev("retirement", ["2"], {}, null), "Rivera abandona."],
  ];
  for (const [name, event, text] of cases) {
    it(name, () => expect(describe(event, ctx)).toBe(text));
  }

  it("un piloto que no está en la lista aparece por su número", () => {
    expect(describe(ev("retirement", ["99"], {}), ctx)).toBe("V22 · #99 abandona.");
  });
});

suite("crónica sin spoilers", () => {
  const r = new RaceBuilder({ drivers: 4, laps: 10 });
  r.at(10_000).start();
  r.at(150_000).pass("3", "2"); // solo participan 2 y 3
  r.at(300_000).pass("4", "2"); // recién acá aparece el 4
  r.at(330_000).retire("4");
  r.at(400_000).finish();
  const full = buildInsights(r.build(), { source: "official" });
  const texts = (ins: ReturnType<typeof insightsAt>) => ins.events.map((e) => describe(e, { drivers: full.drivers }));

  it("lo que se cuenta en un instante es lo mismo que se contará al final, y nada más", () => {
    for (let now = 0; now <= 420_000; now += 12_500) {
      const seen = texts(insightsAt(full, now));
      const later = new Set(full.events.filter((e) => e.ts > now).map((e) => describe(e, { drivers: full.drivers })));
      expect(
        seen.some((t) => later.has(t)),
        `en ${now}`,
      ).toBe(false);
    }
  });

  it("no nombra a un piloto antes de que participe de un evento", () => {
    const early = texts(insightsAt(full, 250_000)).join(" ");
    expect(early).toContain("Piloto C");
    expect(early).not.toContain("Piloto D");
    expect(texts(insightsAt(full, 450_000)).join(" ")).toContain("Piloto D");
  });

  it("el resultado final no aparece en la crónica antes de la bandera a cuadros", () => {
    const before = texts(insightsAt(full, 399_000)).join(" ");
    expect(before).not.toMatch(/gana la carrera|ganador|victoria|termina/i);
    expect(insightsAt(full, 399_000).final).toEqual({});
  });
});
