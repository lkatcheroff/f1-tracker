import { describe, expect, it } from "vitest";
import { radioId, radioTranscriptFile } from "../src";

const URL_ =
  "https://livetiming.formula1.com/static/2026/2026-10-11_Singapore_Grand_Prix/2026-10-11_Race/TeamRadio/ALB_23_20261011_195602.mp3";

describe("radio: ubicar el mensaje y su archivo de transcripciones", () => {
  it("el id es el nombre del audio", () => {
    expect(radioId(URL_)).toBe("ALB_23_20261011_195602.mp3");
    expect(radioId(`${URL_}?x=1`)).toBe("ALB_23_20261011_195602.mp3");
  });

  it("el archivo sale de la carpeta de la sesión, sin barras", () => {
    expect(radioTranscriptFile(URL_)).toBe("2026__2026-10-11_Singapore_Grand_Prix__2026-10-11_Race.json");
  });

  it("dos mensajes de la misma sesión comparten archivo; de otra sesión, no", () => {
    expect(radioTranscriptFile(URL_.replace("ALB_23_20261011_195602", "VER_3_20261011_212832"))).toBe(radioTranscriptFile(URL_));
    expect(radioTranscriptFile(URL_.replace("Race", "Qualifying"))).not.toBe(radioTranscriptFile(URL_));
  });

  it("direcciones que no son de radio devuelven null", () => {
    for (const bad of ["", "https://ejemplo.test/a.mp3", "https://livetiming.formula1.com/static/2026/x/TeamRadio/a.txt"]) {
      expect(radioId(bad)).toBeNull();
      expect(radioTranscriptFile(bad)).toBeNull();
    }
  });

  it("el nombre del archivo nunca puede ser una ruta", () => {
    const f = radioTranscriptFile("https://x.test/static/../../etc/TeamRadio/a.mp3");
    expect(f === null || /^[\w.-]+\.json$/.test(f)).toBe(true);
  });
});
