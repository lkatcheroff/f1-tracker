import { describe, expect, it } from "vitest";
import { buildInsights, type DataSourceKind, type RawMessage } from "../src";
import { sampleRace } from "./builders";

const SOURCES: DataSourceKind[] = ["official", "openf1", "recording"];
const base = () => sampleRace().build();

/** Contrato: cada origen declara qué aproxima o no trae, y los indicadores salen de lo que la sesión trae de verdad. */
describe("calidad de datos por origen", () => {
  it("cada origen declara su fuente y sus aproximaciones", () => {
    for (const source of SOURCES) {
      const q = buildInsights(base(), { source }).dataQuality;
      expect(q.source).toBe(source);
      expect(Array.isArray(q.approximations)).toBe(true);
      for (const a of q.approximations) expect(a.trim().length, `${source}: aproximación vacía`).toBeGreaterThan(10);
      expect(new Set(q.approximations).size, `${source}: repetidas`).toBe(q.approximations.length);
    }
  });

  it("el archivo oficial no aproxima nada; OpenF1 y la grabación sí avisan", () => {
    expect(buildInsights(base(), { source: "official" }).dataQuality.approximations).toEqual([]);
    expect(buildInsights(base(), { source: "openf1" }).dataQuality.approximations.length).toBeGreaterThan(0);
    expect(buildInsights(base(), { source: "recording" }).dataQuality.approximations.length).toBeGreaterThan(0);
  });

  it("OpenF1 avisa de todo lo que su adaptador deduce", () => {
    const text = buildInsights(base(), { source: "openf1" }).dataQuality.approximations.join(" | ");
    for (const topic of [/abandonos/i, /estado de pista|safety car/i, /mini-sectores/i]) expect(text).toMatch(topic);
  });

  it("hasPositions y hasTelemetry reflejan lo que trae la sesión, no el origen", () => {
    const without = buildInsights(base(), { source: "official" }).dataQuality;
    expect(without).toMatchObject({ hasPositions: false, hasTelemetry: false });

    const withPos: RawMessage[] = [...base(), { topic: "Position", ts: 20_000, data: { "1": [100, 200, 1, 0] } }];
    expect(buildInsights(withPos, { source: "openf1" }).dataQuality.hasPositions).toBe(true);

    const withCar: RawMessage[] = [...base(), { topic: "CarData", ts: 20_000, data: { "1": [280, 11000, 7, 100, 0, 0] } }];
    expect(buildInsights(withCar, { source: "official" }).dataQuality.hasTelemetry).toBe(true);
  });

  it("el origen no cambia el análisis: mismos eventos, y la confianza solo puede bajar", () => {
    const [official, ...others] = SOURCES.map((source) => buildInsights(base(), { source }));
    const strip = (e: { confidence: string }) => ({ ...e, confidence: undefined });
    for (const o of others) {
      expect(o.events.map(strip)).toEqual(official.events.map(strip));
      expect(o.laps).toEqual(official.laps);
      o.events.forEach((e, i) => {
        if (official.events[i].confidence !== "high") expect(e.confidence).not.toBe("high");
      });
    }
  });
});
