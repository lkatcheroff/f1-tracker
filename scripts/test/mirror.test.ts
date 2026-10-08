import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type MeetingEntry, PACK_VERSION, type RawMessage, TELEMETRY_VERSION } from "@f1/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type MirrorDeps, type MirrorOptions, mirror } from "../mirror-lib";

const NOW = Date.parse("2026-10-08T12:00:00Z");
const DAY = 86_400_000;

/** Una sesión que ya terminó hace `daysAgo` días. */
const session = (key: number, daysAgo: number) => ({
  key,
  name: "Race",
  type: "Race",
  startUtc: new Date(NOW - daysAgo * DAY).toISOString(),
  endUtc: new Date(NOW - daysAgo * DAY + 2 * 3600_000).toISOString(),
  path: null,
  data: null,
});
const calendarOf = (...sessions: ReturnType<typeof session>[]): MeetingEntry[] => [
  { key: 1, name: "Gran Premio", location: "X", country: "Y", sessions },
];

/** Lo mínimo para que la sesión se pueda empaquetar. */
const messages = (): RawMessage[] => [
  {
    topic: "DriverList",
    ts: 0,
    data: { "1": { RacingNumber: "1", Tla: "AAA", FullName: "Pepe QUINTANA", TeamName: "E", TeamColour: "111111" } },
  },
  { topic: "TimingData", ts: 0, data: { Lines: { "1": { Line: 1, Position: "1", NumberOfLaps: 0 } } } },
  { topic: "TimingData", ts: 60_000, data: { Lines: { "1": { NumberOfLaps: 1 } } } },
];

let dir: string;
let meetings: MeetingEntry[];
let loads: string[];
let failing: Set<string>;
let logs: string[];

const deps = (): MirrorDeps => ({
  fetchText: async () => null, // el archivo de F1 contesta 403: todo sale de OpenF1
  loadOpenF1: async (startUtc) => {
    loads.push(startUtc);
    if (failing.has(startUtc)) throw new Error("OpenF1 caído");
    return messages();
  },
  listOpenF1: async (year) => (year === 2026 ? structuredClone(meetings) : []),
  now: () => NOW,
  log: (l) => logs.push(l),
});
const opts = (over: Partial<MirrorOptions> = {}): MirrorOptions => ({ outDir: dir, maxSessions: 40, maxNewOpenF1: 5, ...over });
const files = (sub: string) => readdir(path.join(dir, sub)).then((l) => l.sort());
const published = async () => JSON.parse(await readFile(path.join(dir, "calendar-2026.json"), "utf8")) as MeetingEntry[];

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "mirror-"));
  meetings = calendarOf(session(1, 3), session(2, 5), session(3, 7));
  loads = [];
  failing = new Set();
  logs = [];
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe("espejo del sitio", () => {
  it("la primera corrida publica las sesiones terminadas, con su telemetría y el calendario", async () => {
    const r = await mirror(opts(), deps());
    expect(r).toMatchObject({ changed: true, source: "openf1", published: 3, failed: [] });
    expect(await files("s")).toEqual([1, 2, 3].map((k) => `${k}.v${PACK_VERSION}.json.gz`));
    expect(await files("t")).toEqual([1, 2, 3].map((k) => `${k}.v${TELEMETRY_VERSION}.json.gz`));
    const cal = await published();
    expect(cal[0].sessions.map((s) => s.data)).toEqual([1, 2, 3].map((k) => `s/${k}.v${PACK_VERSION}.json.gz`));
    expect(cal[0].sessions.every((s) => s.path === null)).toBe(true);
  });

  it("una segunda corrida sin novedades no cambia nada ni vuelve a bajar", async () => {
    await mirror(opts(), deps());
    loads = [];
    const out = path.join(dir, "gh-output");
    const r = await mirror(opts({ githubOutput: out }), deps());
    expect(r.changed).toBe(false);
    expect(r.added).toEqual([]);
    expect(loads).toEqual([]);
    expect(await readFile(out, "utf8")).toBe("changed=false\n");
  });

  it("avisa a la Action cuando hubo cambios", async () => {
    const out = path.join(dir, "gh-output");
    await mirror(opts({ githubOutput: out }), deps());
    expect(await readFile(out, "utf8")).toBe("changed=true\n");
  });

  it("respeta el máximo de sesiones nuevas por corrida y completa en las siguientes", async () => {
    const first = await mirror(opts({ maxNewOpenF1: 2 }), deps());
    expect(first.added).toHaveLength(2);
    expect(loads).toHaveLength(2);
    // Las más recientes primero.
    expect(first.added.length + 1).toBe(3);
    expect((await files("s")).length).toBe(2);
    expect((await published())[0].sessions.filter((s) => s.data).length).toBe(2);

    const second = await mirror(opts({ maxNewOpenF1: 2 }), deps());
    expect(second.added).toHaveLength(1);
    expect((await files("s")).length).toBe(3);
    expect((await mirror(opts({ maxNewOpenF1: 2 }), deps())).changed).toBe(false);
  });

  it("no publica sesiones que terminaron hace menos de 40 minutos ni futuras", async () => {
    const recent = { ...session(9, 0), endUtc: new Date(NOW - 10 * 60_000).toISOString() };
    const future = { ...session(10, 0), startUtc: new Date(NOW + DAY).toISOString(), endUtc: new Date(NOW + DAY + 3600_000).toISOString() };
    meetings = calendarOf(session(1, 3), recent, future);
    const r = await mirror(opts(), deps());
    expect(r.published).toBe(1);
    expect(await files("s")).toEqual([`1.v${PACK_VERSION}.json.gz`]);
  });

  it("si falla la regeneración, sigue publicada la versión anterior y se reintenta", async () => {
    await mirror(opts(), deps());
    // Quedó una versión vieja de la sesión 2 (formato anterior) y la nueva todavía no existe.
    const oldName = `2.v${PACK_VERSION - 1}.json.gz`;
    await writeFile(path.join(dir, "s", oldName), "viejo");
    await rm(path.join(dir, "s", `2.v${PACK_VERSION}.json.gz`));
    failing.add(meetings[0].sessions[1].startUtc);

    const r = await mirror(opts(), deps());
    expect(r.failed).toHaveLength(1);
    expect(await files("s")).toContain(oldName);
    expect((await published())[0].sessions[1].data).toBe(`s/${oldName}`);
    expect(r.published).toBe(3);

    // Cuando OpenF1 vuelve, se regenera y recién ahí desaparece la versión vieja.
    failing.clear();
    const again = await mirror(opts(), deps());
    expect(again.failed).toEqual([]);
    expect(await files("s")).not.toContain(oldName);
    expect(await files("s")).toContain(`2.v${PACK_VERSION}.json.gz`);
  });

  it("una sesión que falla y nunca tuvo versión anterior queda sin datos, sin frenar a las demás", async () => {
    failing.add(meetings[0].sessions[0].startUtc);
    const r = await mirror(opts(), deps());
    expect(r.failed).toHaveLength(1);
    expect(r.published).toBe(2);
    expect((await published())[0].sessions[0].data).toBeNull();
    expect(logs.some((l) => l.includes("OpenF1 caído"))).toBe(true);
  });

  it("una sesión sin TimingData no se publica", async () => {
    const d = deps();
    d.loadOpenF1 = async () => [{ topic: "Heartbeat", ts: 0, data: {} }];
    const r = await mirror(opts(), d);
    expect(r.published).toBe(0);
    expect(r.failed).toHaveLength(3);
  });

  it("lo que sale de la ventana se borra, con su telemetría", async () => {
    await mirror(opts(), deps());
    const r = await mirror(opts({ maxSessions: 2 }), deps());
    expect(r.changed).toBe(true);
    expect(await files("s")).toEqual([1, 2].map((k) => `${k}.v${PACK_VERSION}.json.gz`));
    expect(await files("t")).toEqual([1, 2].map((k) => `${k}.v${TELEMETRY_VERSION}.json.gz`));
  });

  it("guarda el calendario de temporadas anteriores una sola vez", async () => {
    const d = deps();
    d.listOpenF1 = async (year) => (year === 2025 ? calendarOf(session(500, 400)) : year === 2026 ? structuredClone(meetings) : []);
    await mirror(opts(), d);
    expect(await readdir(dir)).toContain("calendar-2025.json");
    const before = await readFile(path.join(dir, "calendar-2025.json"), "utf8");
    d.listOpenF1 = async (year) => (year === 2026 ? structuredClone(meetings) : calendarOf(session(501, 1)));
    await mirror(opts(), d);
    expect(await readFile(path.join(dir, "calendar-2025.json"), "utf8")).toBe(before);
  });

  it("con el archivo de F1 disponible, usa su calendario y no pasa por OpenF1", async () => {
    const index = {
      Meetings: [
        {
          Key: 7,
          Name: "GP",
          Location: "L",
          Country: { Name: "C" },
          Sessions: [
            {
              Key: 70,
              Name: "Race",
              Type: "Race",
              StartDate: "2026-09-01T13:00:00",
              EndDate: "2026-09-01T15:00:00",
              GmtOffset: "02:00:00",
              Path: "2026/x/",
            },
          ],
        },
      ],
    };
    const d = deps();
    d.fetchText = async (url) => {
      if (url.endsWith("2026/Index.json")) return JSON.stringify(index);
      if (url.endsWith("TimingData.jsonStream")) return '00:00:00.000{"Lines":{"1":{"Line":1,"Position":"1","NumberOfLaps":0}}}\r\n';
      return null;
    };
    const r = await mirror(opts(), d);
    expect(r.source).toBe("f1");
    expect(loads).toEqual([]);
    expect(r.published).toBe(1);
    const cal = await published();
    expect(cal[0].sessions[0].startUtc).toBe("2026-09-01T11:00:00.000Z");
    expect(cal[0].sessions[0].path).toBeNull();
  });

  it("`forceOpenF1` ignora el archivo de F1 aunque responda", async () => {
    const d = deps();
    d.fetchText = async () => JSON.stringify({ Meetings: [{ Key: 1, Name: "x", Sessions: [] }] });
    expect((await mirror(opts({ forceOpenF1: true }), d)).source).toBe("openf1");
  });
});
