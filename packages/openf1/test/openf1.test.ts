import { findOutline, prepareMessages, type RawMessage } from "@f1/core";
import { afterEach, describe, expect, it } from "vitest";
import { adaptOpenF1, configureOpenF1, listOpenF1Meetings, loadOpenF1Session } from "../src";

/** Un OpenF1 de mentira: responde por endpoint con respuestas mínimas y deja registro de los pedidos. */
type Row = Record<string, any>;
type Handler = (url: URL, call: number) => Response | Row[];

const T0 = Date.parse("2026-05-03T13:00:00Z");
const iso = (ms: number) => new Date(T0 + ms).toISOString();
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

const session = {
  session_key: 9,
  meeting_key: 1,
  session_type: "Race",
  session_name: "Race",
  date_start: iso(0),
  date_end: iso(3600_000),
  country_name: "Italia",
  circuit_key: 6,
  circuit_short_name: "Imola",
};
const driver = {
  driver_number: 1,
  name_acronym: "AAA",
  full_name: "Pepe QUINTANA",
  broadcast_name: "P QUINTANA",
  team_name: "Equipo",
  team_colour: "111111",
};

function fake(routes: Record<string, Handler>) {
  const log: { endpoint: string; url: URL }[] = [];
  const calls: Record<string, number> = {};
  const fetchFn = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    const endpoint = url.pathname.split("/").pop() ?? "";
    log.push({ endpoint, url });
    calls[endpoint] = (calls[endpoint] ?? 0) + 1;
    const h = routes[endpoint];
    if (!h) return json([]);
    const r = h(url, calls[endpoint]);
    return r instanceof Response ? r : json(r);
  }) as typeof fetch;
  const waits: number[] = [];
  configureOpenF1({ fetch: fetchFn, sleep: async (ms) => void waits.push(ms), throttle: false });
  return { log, waits };
}

afterEach(() => configureOpenF1());

/** Circuito circular de 2.500 unidades de radio: `n` puntos por vuelta, empezando por la meta. */
function loop(lapStart: number, lapMs: number, n = 120): Row[] {
  return Array.from({ length: n + 1 }, (_, i) => {
    const a = (i / n) * Math.PI * 2;
    return {
      driver_number: 1,
      date: iso(lapStart + (i / n) * lapMs),
      x: Math.round(2500 * Math.cos(a)),
      y: Math.round(2500 * Math.sin(a)),
    };
  });
}

/** Rango pedido: OpenF1 usa `date>…&date<…` (el operador va en la clave, sin `=`). */
const rangeOf = (url: URL): [number, number] => [
  Date.parse(decodeURIComponent(url.search.match(/date(?:%3E|>)([^&]+)/)?.[1] ?? "")),
  Date.parse(decodeURIComponent(url.search.match(/date(?:%3C|<)([^&]+)/)?.[1] ?? "")),
];

const base: Record<string, Handler> = {
  sessions: () => [session],
  meetings: () => [{ meeting_key: 1, meeting_name: "Gran Premio de Imola" }],
  drivers: () => [driver],
  laps: () => [
    { driver_number: 1, lap_number: 1, date_start: iso(120_000), lap_duration: 60 },
    { driver_number: 1, lap_number: 2, date_start: iso(180_000), lap_duration: 60 },
  ],
  race_control: () => [],
};

describe("cliente HTTP", () => {
  it("arma la query con operadores en la clave", async () => {
    const { log } = fake({
      ...base,
      location: () => loop(0, 60_000),
    });
    await loadOpenF1Session(session.date_start, () => {});
    const loc = log.find((l) => l.endpoint === "location");
    expect(loc?.url.search).toMatch(/session_key=9&driver_number=1&date(%3E|>)[^&]+&date(%3C|<)/);
  });

  it("422: reintenta una vez el mismo rango", async () => {
    const { log, waits } = fake({
      ...base,
      location: (_u, n) => (n === 1 ? json({ detail: "demasiados datos" }, 422) : loop(0, 60_000)),
    });
    const msgs = await loadOpenF1Session(session.date_start, () => {});
    const asked = log.filter((l) => l.endpoint === "location");
    expect(asked).toHaveLength(2);
    expect(asked[1].url.search).toBe(asked[0].url.search);
    expect(waits).toContain(3000);
    expect(msgs.some((m) => m.topic === "Position")).toBe(true);
  });

  it("422 persistente: parte el rango en dos mitades que juntas lo cubren", async () => {
    const { log } = fake({
      ...base,
      // Una carrera de 40 minutos: el pedido entero (44) supera el umbral y hay que partirlo.
      laps: () => [
        { driver_number: 1, lap_number: 1, date_start: iso(0), lap_duration: 60 },
        { driver_number: 1, lap_number: 2, date_start: iso(2_400_000), lap_duration: 60 },
      ],
      location: (url) => {
        const [a, b] = rangeOf(url);
        // Rechaza todo pedido de más de 10 minutos, siempre.
        return b - a > 10 * 60_000 ? json({}, 422) : loop(a - T0, 60_000, 20);
      },
    });
    const msgs = await loadOpenF1Session(session.date_start, () => {});
    const ranges = log.filter((l) => l.endpoint === "location").map((l) => rangeOf(l.url));
    const full = ranges[0];
    const ok = ranges.filter(([a, b]) => b - a <= 10 * 60_000).sort((x, y) => x[0] - y[0]);
    expect(ok.length).toBeGreaterThanOrEqual(2);
    // Las mitades aceptadas empiezan donde empezó el pedido, terminan donde terminó y no dejan huecos.
    expect(ok[0][0]).toBe(full[0]);
    expect(ok[ok.length - 1][1]).toBe(full[1]);
    for (let i = 1; i < ok.length; i++) expect(Math.abs(ok[i][0] - ok[i - 1][1])).toBeLessThanOrEqual(1);
    expect(msgs.length).toBeGreaterThan(0);
  });

  it("422 que no se puede partir más: el error sale, no se traga", async () => {
    fake({ ...base, location: () => json({}, 422) });
    await expect(loadOpenF1Session(session.date_start, () => {})).rejects.toThrow(/HTTP 422/);
  });

  it("5xx es pasajero: reintenta con espera creciente", async () => {
    const { waits } = fake({ ...base, weather: (_u, n) => (n < 3 ? json({}, 503) : []), location: () => loop(0, 60_000) });
    await loadOpenF1Session(session.date_start, () => {});
    expect(waits.filter((w) => w >= 5000)).toEqual([5000, 10_000]);
  });

  it("404 es una lista vacía; otros 4xx son un error", async () => {
    fake({ ...base, weather: () => json({}, 404), location: () => loop(0, 60_000) });
    await expect(loadOpenF1Session(session.date_start, () => {})).resolves.toBeDefined();
    fake({ ...base, weather: () => json({}, 400) });
    await expect(loadOpenF1Session(session.date_start, () => {})).rejects.toThrow(/HTTP 400/);
  });

  it("sin vueltas todavía: dice que el histórico no está listo", async () => {
    fake({ ...base, laps: () => [] });
    await expect(loadOpenF1Session(session.date_start, () => {})).rejects.toThrow(/todavía no tiene datos/);
  });

  it("sin sesión cerca de esa hora, falla con un mensaje claro", async () => {
    fake({ ...base, sessions: () => [{ ...session, date_start: iso(-48 * 3600_000) }] });
    await expect(loadOpenF1Session(session.date_start, () => {})).rejects.toThrow(/no tiene una sesión/);
  });

  it("pide car_data solo si se lo piden", async () => {
    const a = fake({ ...base, location: () => loop(0, 60_000) });
    await loadOpenF1Session(session.date_start, () => {});
    expect(a.log.some((l) => l.endpoint === "car_data")).toBe(false);
    const b = fake({
      ...base,
      location: () => loop(0, 60_000),
      car_data: () => [{ driver_number: 1, date: iso(5000), speed: 280, rpm: 11000, n_gear: 7, throttle: 100, brake: 0 }],
    });
    const msgs = await loadOpenF1Session(session.date_start, () => {}, { withCar: true });
    expect(b.log.some((l) => l.endpoint === "car_data")).toBe(true);
    expect(msgs.some((m) => m.topic === "CarData")).toBe(true);
  });

  it("calendario: ordena, descarta sesiones canceladas y reuniones vacías", async () => {
    fake({
      meetings: () => [
        { meeting_key: 2, meeting_name: "B", location: "b", country_name: "B", date_start: iso(2_000_000) },
        { meeting_key: 1, meeting_name: "A", location: "a", country_name: "A", date_start: iso(1_000_000) },
        { meeting_key: 3, meeting_name: "C", location: "c", country_name: "C", date_start: iso(3_000_000) },
      ],
      sessions: () => [
        {
          session_key: 20,
          meeting_key: 2,
          session_name: "Race",
          session_type: "Race",
          date_start: iso(2_100_000),
          date_end: iso(2_200_000),
          is_cancelled: false,
        },
        {
          session_key: 10,
          meeting_key: 1,
          session_name: "Race",
          session_type: "Race",
          date_start: iso(1_100_000),
          date_end: iso(1_200_000),
        },
        {
          session_key: 11,
          meeting_key: 1,
          session_name: "Sprint",
          session_type: "Race",
          date_start: iso(1_050_000),
          date_end: iso(1_060_000),
          is_cancelled: true,
        },
      ],
    });
    const cal = await listOpenF1Meetings(2026);
    expect(cal.map((m) => m.name)).toEqual(["A", "B"]);
    expect(cal[0].sessions.map((s) => s.key)).toEqual([10]);
  });
});

describe("traducción al feed", () => {
  const msgs = (pit: Row[]): RawMessage[] =>
    adaptOpenF1({
      session,
      meeting: undefined,
      drivers: [driver],
      laps: [
        { driver_number: 1, lap_number: 1, date_start: iso(0), lap_duration: 60 },
        { driver_number: 1, lap_number: 2, date_start: iso(60_000), lap_duration: 60 },
      ],
      intervals: [],
      position: [],
      stints: [],
      pit,
      raceControl: [],
      weather: [],
      results: [],
      location: [],
      car: [],
    });
  const inPit = (all: RawMessage[], v: boolean) => all.filter((m) => m.topic === "TimingData" && (m.data as Row).Lines?.["1"]?.InPit === v);

  it("el `date` de un pit es el instante de salida; la entrada es esa hora menos la calle de boxes", () => {
    const all = msgs([{ driver_number: 1, date: iso(100_000), lane_duration: 22, pit_duration: 2.4, lap_number: 2 }]);
    const out = inPit(all, false).filter((m) => m.ts > 0);
    const into = inPit(all, true);
    expect(out.map((m) => m.ts)).toEqual([100_000]);
    expect(into.map((m) => m.ts)).toEqual([78_000]);
    expect((into[0].data as Row).Lines["1"].NumberOfPitStops).toBe(1);
  });

  it("sin duración de la calle, usa la de la parada; sin ninguna, 22 s; nunca antes de cero", () => {
    expect(inPit(msgs([{ driver_number: 1, date: iso(100_000), pit_duration: 30 }]), true).map((m) => m.ts)).toEqual([70_000]);
    expect(inPit(msgs([{ driver_number: 1, date: iso(100_000) }]), true).map((m) => m.ts)).toEqual([78_000]);
    expect(inPit(msgs([{ driver_number: 1, date: iso(10_000), lane_duration: 22 }]), true).map((m) => m.ts)).toEqual([0]);
  });

  it("numera las paradas por piloto en orden de tiempo, aunque lleguen desordenadas", () => {
    const all = msgs([
      { driver_number: 1, date: iso(200_000), lane_duration: 20 },
      { driver_number: 1, date: iso(100_000), lane_duration: 20 },
    ]);
    const stops = inPit(all, true).map((m) => [m.ts, (m.data as Row).Lines["1"].NumberOfPitStops]);
    expect(stops).toEqual([
      [80_000, 1],
      [180_000, 2],
    ]);
  });
});

describe("vuelta de formación (regresión)", () => {
  it("el trazado sale de una sola vuelta aunque location traiga la de formación", async () => {
    // OpenF1 trae la vuelta de formación (antes de la largada) y después las de carrera.
    const formation = loop(-120_000, 100_000);
    const race = [...loop(0, 60_000), ...loop(60_000, 60_000), ...loop(120_000, 60_000)];
    fake({
      ...base,
      laps: () => [1, 2, 3].map((n) => ({ driver_number: 1, lap_number: n, date_start: iso((n - 1) * 60_000), lap_duration: 60 })),
      location: () => [...formation, ...race],
    });
    const msgs = prepareMessages(await loadOpenF1Session(session.date_start, () => {}));
    const outline = findOutline(msgs);
    expect(outline).not.toBeNull();
    const pts = outline!.points;
    let length = 0;
    for (let i = 1; i < pts.length; i++) length += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    // Una vuelta de verdad mide ~2π·2500 ≈ 15.700; dos vueltas medirían el doble.
    expect(length).toBeGreaterThan(15_000);
    expect(length).toBeLessThan(16_500);
  });
});
