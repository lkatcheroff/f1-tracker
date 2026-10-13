import { describe, expect, it } from "vitest";
import {
  buildClock,
  buildIndex,
  clockParts,
  parseClockText,
  parseRemainingInput,
  partLength,
  type RawMessage,
  remainingAt,
  tsAtRemaining,
} from "../src";

const S = 1000;
const MIN = 60 * S;
const clk = (ts: number, Remaining: string, Extrapolating?: boolean): RawMessage => ({
  topic: "ExtrapolatedClock",
  ts,
  data: { Utc: "2026-09-25T11:47:16.007Z", Remaining, ...(Extrapolating === undefined ? {} : { Extrapolating }) },
});
const part = (ts: number, SessionPart: number): RawMessage => ({ topic: "TimingData", ts, data: { SessionPart, Lines: {} } });

/** La forma del feed real de una clasificación: reinicio detenido, arranque corriendo, parada en 0, y las partes anunciadas después. */
const quali = (): RawMessage[] => [
  part(0, 0),
  clk(2 * S, "00:18:00", false),
  part(3 * S, 1),
  clk(1000 * S, "00:17:59", true), // Q1 largó: 16:40 de grabación
  clk(2100 * S, "00:00:00", false), // Q1 terminó
  clk(2445 * S, "00:15:00"), // reinicio para Q2: sin "Extrapolating", sigue detenido
  part(2446 * S, 2),
  clk(2506 * S, "00:14:59", true),
  clk(3400 * S, "00:00:00", false), // Q2 terminó
  clk(3760 * S, "00:12:00"), // reinicio para Q3
  part(3761 * S, 3),
  clk(3820 * S, "00:11:59", true),
  clk(4600 * S, "00:00:00", false),
];

describe("lectura del reloj", () => {
  it("entiende los textos del feed", () => {
    expect(parseClockText("00:17:59")).toBe(17 * MIN + 59 * S);
    expect(parseClockText("01:00:00")).toBe(60 * MIN);
    expect(parseClockText("18:00")).toBe(18 * MIN);
    expect(parseClockText("basura")).toBeNull();
    expect(parseClockText(undefined)).toBeNull();
  });

  it("entiende lo que escribe una persona", () => {
    expect(parseRemainingInput("3:15")).toBe(3 * MIN + 15 * S);
    expect(parseRemainingInput("03:15")).toBe(3 * MIN + 15 * S);
    expect(parseRemainingInput(" 12:00 ")).toBe(12 * MIN);
    expect(parseRemainingInput("1:03:15")).toBe(63 * MIN + 15 * S);
    expect(parseRemainingInput("3")).toBe(3 * MIN);
    expect(parseRemainingInput("3,5")).toBe(210 * S);
    for (const bad of ["", "abc", "3:75", "3:", ":30", "1:2:3:4", "-3:00"]) expect(parseRemainingInput(bad), bad).toBeNull();
  });
});

describe("reloj de la sesión", () => {
  const clock = buildClock(quali());

  it("guarda las anclas, hereda lo que no viene en el delta y asigna la parte", () => {
    expect(clock.map((a) => [a.running, a.part])).toEqual([
      [false, 1],
      [true, 1],
      [false, 1],
      [false, 2], // el reinicio de Q2 va antes de que se anuncie la parte: igual pertenece a Q2
      [true, 2],
      [false, 2], // cierre de Q2: no se contagia de la Q3 que se anuncia después
      [false, 3],
      [true, 3],
      [false, 3],
    ]);
    expect(clockParts(clock)).toEqual([1, 2, 3]);
  });

  it("calcula cuánto falta en cualquier momento", () => {
    expect(remainingAt(clock, 0)).toBeNull();
    expect(remainingAt(clock, 500 * S)).toMatchObject({ remainingMs: 18 * MIN, running: false });
    expect(remainingAt(clock, 1000 * S)).toMatchObject({ remainingMs: 17 * MIN + 59 * S, running: true, part: 1 });
    expect(remainingAt(clock, 1060 * S)?.remainingMs).toBe(16 * MIN + 59 * S);
    expect(remainingAt(clock, 2100 * S)).toMatchObject({ remainingMs: 0, running: false });
    expect(remainingAt(clock, 9999 * S)?.remainingMs).toBe(0);
    expect(remainingAt(clock, 2506 * S + 5 * MIN)).toMatchObject({ remainingMs: 14 * MIN + 59 * S - 5 * MIN, running: true, part: 2 });
  });

  it("no baja de cero aunque la ancla siguiente tarde", () => {
    const c = buildClock([clk(0, "00:00:10", true)]);
    expect(remainingAt(c, 60 * S)?.remainingMs).toBe(0);
  });

  it("encuentra el momento en que faltaba X, en la parte correcta", () => {
    const end = 5000 * S;
    // Q1: faltando 3:15 → 17:59 − 3:15 = 14:44 de reloj corrido desde la ancla
    expect(tsAtRemaining(clock, 1, 3 * MIN + 15 * S, end)).toBe(1000 * S + (17 * MIN + 59 * S - (3 * MIN + 15 * S)));
    // Q2: mismo texto, otro momento
    expect(tsAtRemaining(clock, 2, 3 * MIN + 15 * S, end)).toBe(2506 * S + (14 * MIN + 59 * S - (3 * MIN + 15 * S)));
    // volver a lo que devuelve el reloj: ida y vuelta
    for (const [p, r] of [
      [1, 10 * MIN],
      [2, 3 * MIN + 15 * S],
      [2, 0],
    ] as const) {
      const ts = tsAtRemaining(clock, p, r, end);
      expect(ts, `${p} ${r}`).not.toBeNull();
      const back = remainingAt(clock, ts as number);
      expect(back?.part).toBe(p);
      expect(Math.abs((back?.remainingMs ?? -1) - r)).toBeLessThanOrEqual(1);
    }
  });

  it("el arranque exacto de la parte está en el reinicio detenido", () => {
    expect(tsAtRemaining(clock, 2, 15 * MIN, 3500 * S)).toBe(2445 * S);
    expect(tsAtRemaining(clock, 1, 18 * MIN, 3500 * S)).toBe(2 * S);
  });

  it("devuelve null si ese momento no existe", () => {
    expect(tsAtRemaining(clock, 2, 16 * MIN, 3500 * S)).toBeNull(); // Q2 dura 15:00
    expect(tsAtRemaining(clock, 4, 5 * MIN, 5000 * S)).toBeNull(); // no hubo Q4
    expect(tsAtRemaining([], null, 5 * MIN, 1000)).toBeNull();
  });

  it("largo de cada parte", () => {
    expect(partLength(clock, 1)).toBe(18 * MIN);
    expect(partLength(clock, 2)).toBe(15 * MIN);
  });

  it("con bandera roja el reloj se detiene y al volver sigue: el mismo valor no se repite", () => {
    const red = buildClock([
      clk(0, "01:00:00", false),
      clk(100 * S, "00:59:59", true),
      clk(700 * S, "00:50:00", false),
      clk(1300 * S, "00:50:00", true),
    ]);
    expect(remainingAt(red, 1000 * S)).toMatchObject({ remainingMs: 50 * MIN, running: false });
    expect(remainingAt(red, 1300 * S + 10 * S)?.remainingMs).toBe(50 * MIN - 10 * S);
    // 55:00 pasó una sola vez, antes de la bandera roja
    expect(tsAtRemaining(red, null, 55 * MIN, 5000 * S)).toBe(100 * S + (59 * MIN + 59 * S - 55 * MIN));
    // 50:00 es el momento de la parada
    expect(tsAtRemaining(red, null, 50 * MIN, 5000 * S)).toBe(100 * S + (59 * MIN + 59 * S - 50 * MIN));
  });
});

describe("reloj en el índice", () => {
  it("buildIndex lo incluye; sin ExtrapolatedClock queda vacío", () => {
    expect(buildIndex(quali()).clock?.length).toBe(9);
    expect(buildIndex([part(0, 1)]).clock).toEqual([]);
  });
});
