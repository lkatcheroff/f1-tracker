import { describe, expect, it } from "vitest";
import { buildPrompt, type Clip, pendingByFile, serialize } from "../transcribe-lib";

const url = (session: string, id: string) =>
  `https://livetiming.formula1.com/static/2026/2026-10-11_Singapore_Grand_Prix/${session}/TeamRadio/${id}.mp3`;
const clip = (session: string, id: string): Clip => ({ date: "2026-10-11T12:00:00Z", driver: 1, url: url(session, id) });

describe("transcripción de la radio", () => {
  it("el prompt trae los apellidos sin repetir y la jerga de F1", () => {
    const p = buildPrompt(["Max VERSTAPPEN", "Lewis HAMILTON", "Max VERSTAPPEN"]);
    expect(p.match(/VERSTAPPEN/g)).toHaveLength(1);
    expect(p).toContain("Box, box");
    expect(p).toContain("undercut");
  });

  it("sin pilotos, el prompt igual sirve", () => {
    expect(buildPrompt([])).not.toContain("Drivers:");
  });

  it("solo quedan pendientes los mensajes sin transcripción, agrupados por archivo", () => {
    const clips = [clip("2026-10-11_Race", "A_1"), clip("2026-10-11_Race", "B_2"), clip("2026-10-10_Qualifying", "C_3")];
    const race = "2026__2026-10-11_Singapore_Grand_Prix__2026-10-11_Race.json";
    const pending = pendingByFile(clips, { [race]: { "A_1.mp3": { text: "box", lang: "en" } } });
    expect([...pending.keys()].sort()).toEqual([race, "2026__2026-10-11_Singapore_Grand_Prix__2026-10-10_Qualifying.json"].sort());
    expect(pending.get(race)?.map((c) => c.url.split("/").pop())).toEqual(["B_2.mp3"]);
  });

  it("un mensaje sin voz (texto vacío) cuenta como hecho: no se vuelve a intentar", () => {
    const race = "2026__2026-10-11_Singapore_Grand_Prix__2026-10-11_Race.json";
    expect(pendingByFile([clip("2026-10-11_Race", "A_1")], { [race]: { "A_1.mp3": { text: "", lang: "en" } } }).size).toBe(0);
  });

  it("audios que no son de radio se ignoran", () => {
    expect(pendingByFile([{ date: "", driver: 1, url: "https://ejemplo.test/a.mp3" }], {}).size).toBe(0);
  });

  it("el archivo sale ordenado y con un mensaje por línea", () => {
    const text = serialize({ "B.mp3": { text: "dos", lang: "en" }, "A.mp3": { text: "uno “con comillas”", lang: "es" } });
    expect(text.split("\n")[1]).toBe('  "A.mp3": {"text":"uno “con comillas”","lang":"es"},');
    expect(JSON.parse(text)).toEqual({ "A.mp3": { text: "uno “con comillas”", lang: "es" }, "B.mp3": { text: "dos", lang: "en" } });
  });
});
