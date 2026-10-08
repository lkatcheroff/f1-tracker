import type { RawMessage } from "../src";

/**
 * Constructor de escenarios sintéticos de carrera.
 *
 * Emite mensajes con la FORMA real del feed de F1 (verificada contra `schema.json`, que se genera con
 * `npm run fixture:schema`) pero con pilotos, equipos y tiempos inventados. Sirve para testear todo el análisis
 * sin depender de datos reales y sin redistribuirlos.
 *
 * Los mensajes salen ya "preparados": ordenados por `ts`, listos para `StateEngine.apply`.
 *
 * Ejemplo:
 *   const race = new RaceBuilder({ drivers: 4, laps: 10 });
 *   race.at(10_000).start();
 *   race.at(100_000).lap("1", 90_000).lap("2", 91_000);
 *   race.at(120_000).pass("2", "1");
 *   const messages = race.build();
 */

export interface RaceBuilderOptions {
  /** cantidad de pilotos (2 a 22). El primero sale en la pole. */
  drivers?: number;
  /** vueltas de la carrera */
  laps?: number;
  /** compuesto de salida de todos */
  compound?: string;
  /** inicio de la sesión, para los mensajes con hora (Race Control, Heartbeat) */
  utc0?: string;
}

export interface SyntheticDriver {
  num: string;
  tla: string;
  name: string;
  team: string;
  color: string;
}

const COLORS = ["3671C6", "E8002D", "27F4D2", "FF8000", "229971", "0093CC", "6692FF", "B6BABD"];

/** Los pilotos del escenario: nº 1, 2, 3…, siglas AAA, BBB, CCC… y equipos de a dos. Nada que se parezca a la realidad. */
export function syntheticDrivers(n: number): SyntheticDriver[] {
  return Array.from({ length: n }, (_, i) => {
    const letter = String.fromCharCode(65 + i);
    const team = Math.floor(i / 2);
    return {
      num: String(i + 1),
      tla: letter.repeat(3),
      name: `Piloto ${letter}`,
      team: `Equipo ${team + 1}`,
      color: COLORS[team % COLORS.length],
    };
  });
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** 107607 → "1:47.607" */
export function fmtLap(ms: number): string {
  const m = Math.floor(ms / 60000);
  const s = (ms - m * 60000) / 1000;
  return m ? `${m}:${s.toFixed(3).padStart(6, "0")}` : s.toFixed(3);
}

/** 12.3 → "+12.300" */
const fmtGap = (sec: number) => `+${sec.toFixed(3)}`;

type Stint = { compound: string; isNew: boolean };

export class RaceBuilder {
  readonly drivers: SyntheticDriver[];
  readonly totalLaps: number;
  private readonly utc0: number;
  private readonly out: RawMessage[] = [];
  /** cursor de tiempo, ms desde el inicio del stream */
  private t = 0;
  /** nº de auto por posición, de P1 hacia atrás */
  private grid: string[];
  private lapsDone: Record<string, number> = {};
  private bestLap: Record<string, number> = {};
  private overallBest = Number.POSITIVE_INFINITY;
  private stops: Record<string, number> = {};
  private stints: Record<string, Stint[]> = {};
  private rcCount = 0;
  private leaderLap = 1;
  private started = false;
  private finished = false;

  constructor(opts: RaceBuilderOptions = {}) {
    const n = opts.drivers ?? 6;
    if (n < 2 || n > 22) throw new Error("drivers debe estar entre 2 y 22");
    this.drivers = syntheticDrivers(n);
    this.totalLaps = opts.laps ?? 10;
    this.utc0 = Date.parse(opts.utc0 ?? "2030-06-01T12:00:00Z");
    this.grid = this.drivers.map((d) => d.num);
    const compound = opts.compound ?? "MEDIUM";

    for (const d of this.drivers) {
      this.lapsDone[d.num] = 0;
      this.stops[d.num] = 0;
      this.stints[d.num] = [{ compound, isNew: false }];
    }
    this.emitInitialState(compound);
  }

  // --- tiempo ---

  /** Pone el cursor en `ts` (ms desde el inicio del stream). No puede ir hacia atrás. */
  at(ts: number): this {
    if (ts < this.t) throw new Error(`el cursor no puede retroceder: ${ts} < ${this.t}`);
    this.t = ts;
    return this;
  }

  /** Avanza el cursor. */
  after(ms: number): this {
    return this.at(this.t + ms);
  }

  /** Posición actual del cursor. */
  get now(): number {
    return this.t;
  }

  // --- helpers internos ---

  private emit(topic: string, data: unknown, ts = this.t): void {
    this.out.push({ topic, ts, data });
  }

  private line(num: string, delta: Record<string, unknown>, ts = this.t): void {
    this.emit("TimingData", { Lines: { [num]: delta } }, ts);
  }

  private driver(num: string): SyntheticDriver {
    const d = this.drivers.find((x) => x.num === num);
    if (!d) throw new Error(`piloto desconocido: ${num}`);
    return d;
  }

  private position(num: string): number {
    return this.grid.indexOf(num) + 1;
  }

  /** Hora del reloj de pared (sin zona, como las manda Race Control) para el ts dado. */
  private wall(ts = this.t): string {
    return new Date(this.utc0 + ts).toISOString().slice(0, 19);
  }

  private emitInitialState(compound: string): void {
    const blank = { Stopped: false, Value: "", Status: 0, OverallFastest: false, PersonalFastest: false };
    this.emit("Heartbeat", { Utc: new Date(this.utc0).toISOString() });
    this.emit("SessionInfo", {
      Meeting: {
        Key: 9001,
        Name: "Gran Premio de Prueba",
        OfficialName: "FORMULA 1 GRAN PREMIO DE PRUEBA 2030",
        Location: "Pruebaland",
        Number: 1,
        Country: { Key: 99, Code: "TST", Name: "Testland" },
        Circuit: { Key: 9001, ShortName: "Pruebaland" },
      },
      SessionStatus: "Inactive",
      ArchiveStatus: { Status: "Generating" },
      Key: 90001,
      Type: "Race",
      Name: "Race",
      StartDate: this.wall(),
      EndDate: this.wall(7_200_000),
      GmtOffset: "00:00:00",
      Path: "2030/2030-06-01_Gran_Premio_de_Prueba/2030-06-01_Race/",
    });
    this.emit(
      "DriverList",
      Object.fromEntries(
        this.drivers.map((d, i) => [
          d.num,
          { RacingNumber: d.num, BroadcastName: d.tla, FullName: d.name, Tla: d.tla, Line: i + 1, TeamName: d.team, TeamColour: d.color },
        ]),
      ),
    );
    this.emit("TimingData", {
      Lines: Object.fromEntries(
        this.drivers.map((d, i) => [
          d.num,
          {
            GapToLeader: i === 0 ? "LAP 1" : "",
            IntervalToPositionAhead: { Value: i === 0 ? "LAP 1" : "", Catching: false },
            Line: i + 1,
            Position: String(i + 1),
            ShowPosition: true,
            RacingNumber: d.num,
            Retired: false,
            InPit: false,
            PitOut: false,
            Stopped: false,
            Status: 64,
            Sectors: [{ ...blank }, { ...blank }, { ...blank }],
            BestLapTime: { Value: "" },
            LastLapTime: { Value: "", Status: 0, OverallFastest: false, PersonalFastest: false },
          },
        ]),
      ),
      Withheld: false,
    });
    this.emit("TimingAppData", {
      Lines: Object.fromEntries(this.drivers.map((d, i) => [d.num, { RacingNumber: d.num, Line: i + 1, GridPos: String(i + 1) }])),
    });
    this.emit("TimingAppData", {
      Lines: Object.fromEntries(
        this.drivers.map((d) => [
          d.num,
          { Stints: [{ LapFlags: 0, Compound: compound, New: "false", TyresNotChanged: "0", TotalLaps: 0, StartLaps: 0 }] },
        ]),
      ),
    });
    this.emit("LapCount", { CurrentLap: 1, TotalLaps: this.totalLaps });
    this.emit("SessionStatus", { Status: "Inactive", Started: "Inactive" });
    this.emit("TrackStatus", { Status: "1", Message: "AllClear" });
    this.emit("ExtrapolatedClock", { Utc: this.wall(), Remaining: "02:00:00", Extrapolating: false });
  }

  // --- carrera ---

  /** Luces apagadas: la sesión pasa a `Started` y Race Control anuncia la largada. */
  start(): this {
    if (this.started) throw new Error("la carrera ya largó");
    this.started = true;
    this.emit("SessionStatus", { Status: "Started", Started: "Started" });
    this.emit("ExtrapolatedClock", { Utc: this.wall(), Remaining: "01:59:59", Extrapolating: true });
    return this.rc("RACE START", { category: "Other", lap: 1 });
  }

  /**
   * Cierra una vuelta del piloto en el cursor. Los sectores se reparten 34/41/25 % salvo que se pasen.
   * `gap` e `interval` (segundos, o texto como "1L") actualizan los gaps en el mismo instante.
   */
  lap(num: string, ms: number, opts: { sectors?: [number, number, number]; gap?: number | string; interval?: number | string } = {}): this {
    this.driver(num);
    const n = ++this.lapsDone[num];
    const sectors = opts.sectors ?? [Math.round(ms * 0.34), Math.round(ms * 0.41), ms - Math.round(ms * 0.34) - Math.round(ms * 0.41)];
    const sec = (i: number) => (sectors[i] / 1000).toFixed(3);
    // S1 y S2 salen antes del cierre, en su momento.
    this.line(num, { Sectors: { 0: { Value: sec(0) } } }, this.t - sectors[1] - sectors[2]);
    this.line(num, { Sectors: { 1: { Value: sec(1) } } }, this.t - sectors[2]);

    const pb = ms < (this.bestLap[num] ?? Number.POSITIVE_INFINITY);
    const ob = ms < this.overallBest;
    if (pb) this.bestLap[num] = ms;
    if (ob) this.overallBest = ms;
    const delta: Record<string, unknown> = {
      NumberOfLaps: n,
      Sectors: { 2: { Value: sec(2), ...(pb ? { PersonalFastest: true } : {}) } },
      LastLapTime: { Value: fmtLap(ms), ...(pb ? { PersonalFastest: true } : {}), ...(ob ? { OverallFastest: true } : {}) },
      PitOut: false,
    };
    if (pb) delta.BestLapTime = { Value: fmtLap(ms), Lap: n };
    this.line(num, delta);
    if (opts.gap !== undefined || opts.interval !== undefined) this.gap(num, { gap: opts.gap, interval: opts.interval });

    // El contador de vueltas avanza cuando el líder cruza la meta.
    if (this.position(num) === 1 && n >= this.leaderLap && n < this.totalLaps) {
      this.leaderLap = n + 1;
      this.emit("LapCount", { CurrentLap: this.leaderLap });
    }
    return this;
  }

  /** Gaps de un piloto: segundos (se formatean como `+x.xxx`) o texto como "1L" o "LAP 12". */
  gap(num: string, g: { gap?: number | string; interval?: number | string }): this {
    this.driver(num);
    const txt = (v: number | string) => (typeof v === "number" ? fmtGap(v) : v);
    const delta: Record<string, unknown> = {};
    if (g.gap !== undefined) delta.GapToLeader = txt(g.gap);
    if (g.interval !== undefined) delta.IntervalToPositionAhead = { Value: txt(g.interval) };
    this.line(num, delta);
    return this;
  }

  /**
   * Fija el orden de carrera (de P1 hacia atrás). Emite un solo mensaje con el `Position`/`Line` de los pilotos
   * que cambiaron, como el feed: un sobrepaso siempre llega como mínimo de a dos cambios en el mismo delta.
   */
  order(nums: string[]): this {
    if (nums.length !== this.grid.length || new Set(nums).size !== nums.length)
      throw new Error("order() necesita a todos los pilotos, una vez cada uno");
    for (const n of nums) this.driver(n);
    const lines: Record<string, unknown> = {};
    nums.forEach((num, i) => {
      if (this.grid[i] !== num) lines[num] = { Line: i + 1, Position: String(i + 1) };
    });
    this.grid = [...nums];
    if (Object.keys(lines).length) this.emit("TimingData", { Lines: lines });
    return this;
  }

  /** `passer` pasa a `passed`, que iba justo delante. */
  pass(passer: string, passed: string): this {
    const i = this.grid.indexOf(passed);
    if (i < 0 || this.grid[i + 1] !== passer) throw new Error(`${passed} tiene que ir justo delante de ${passer}`);
    const next = [...this.grid];
    next[i] = passer;
    next[i + 1] = passed;
    return this.order(next);
  }

  /** Entra a boxes: cuenta una parada y marca `InPit`. */
  pitIn(num: string): this {
    this.driver(num);
    this.stops[num]++;
    this.line(num, { InPit: true, NumberOfPitStops: this.stops[num] });
    return this;
  }

  /** Sale de boxes con neumáticos nuevos. `PitOut` se apaga solo 40 s después, como en el feed. */
  pitOut(num: string, opts: { compound?: string; isNew?: boolean } = {}): this {
    this.driver(num);
    const stint: Stint = { compound: opts.compound ?? "HARD", isNew: opts.isNew ?? true };
    this.stints[num].push(stint);
    const idx = this.stints[num].length - 1;
    this.line(num, { InPit: false, PitOut: true });
    this.emit("TimingAppData", {
      Lines: {
        [num]: {
          Stints: {
            [idx]: { LapFlags: 0, Compound: stint.compound, New: String(stint.isNew), TyresNotChanged: "0", TotalLaps: 0, StartLaps: 0 },
          },
        },
      },
    });
    this.line(num, { PitOut: false }, this.t + 40_000);
    return this;
  }

  /** Abandona: queda parado y fuera de carrera. */
  retire(num: string): this {
    this.driver(num);
    this.line(num, { Stopped: true, Retired: true });
    return this;
  }

  /** Safety Car desplegado (o virtual). */
  safetyCar(kind: "SC" | "VSC" = "SC"): this {
    const virtual = kind === "VSC";
    this.emit("TrackStatus", virtual ? { Status: "6", Message: "VSCDeployed" } : { Status: "4", Message: "SCDeployed" });
    return this.rc(virtual ? "VIRTUAL SAFETY CAR DEPLOYED" : "SAFETY CAR DEPLOYED", {
      category: "SafetyCar",
      mode: virtual ? "VIRTUAL SAFETY CAR" : "SAFETY CAR",
      status: "DEPLOYED",
    });
  }

  /** Bandera roja. */
  redFlag(): this {
    this.emit("TrackStatus", { Status: "5", Message: "Red" });
    this.emit("SessionStatus", { Status: "Aborted", Started: "Started" });
    return this.rc("RED FLAG", { category: "Flag", flag: "RED", scope: "Track" });
  }

  /** Pista libre otra vez. */
  allClear(): this {
    this.emit("TrackStatus", { Status: "1", Message: "AllClear" });
    return this.rc("TRACK CLEAR", { category: "Flag", flag: "CLEAR", scope: "Track" });
  }

  /** Bandera amarilla en un sector de banderilleros. */
  yellow(sector: number, clear = false): this {
    return this.rc(clear ? `CLEAR IN TRACK SECTOR ${sector}` : `YELLOW IN TRACK SECTOR ${sector}`, {
      category: "Flag",
      flag: clear ? "CLEAR" : "YELLOW",
      scope: "Sector",
      sector,
    });
  }

  // --- Race Control ---

  /** Mensaje de Race Control. El primero del feed llega como array y los siguientes como objeto con índice. */
  rc(
    message: string,
    opts: { category?: string; flag?: string; scope?: string; sector?: number; mode?: string; status?: string; lap?: number } = {},
  ): this {
    const m: Record<string, unknown> = {
      Utc: this.wall(),
      Lap: opts.lap ?? this.leaderLap,
      Category: opts.category ?? "Other",
      ...(opts.flag ? { Flag: opts.flag } : {}),
      ...(opts.scope ? { Scope: opts.scope } : {}),
      ...(opts.sector !== undefined ? { Sector: opts.sector } : {}),
      ...(opts.mode ? { Mode: opts.mode } : {}),
      ...(opts.status ? { Status: opts.status } : {}),
      Message: message,
    };
    this.emit("RaceControlMessages", { Messages: this.rcCount === 0 ? [m] : { [this.rcCount]: m } });
    this.rcCount++;
    return this;
  }

  private car(num: string): string {
    const d = this.driver(num);
    return `CAR ${num} (${d.tla})`;
  }

  /** Sanción de tiempo. Como en el feed, el mensaje no trae el piloto como campo: solo en el texto. */
  penalty(num: string, opts: { seconds?: number; kind?: "time" | "drive-through" | "stop-go"; reason?: string }): this {
    const kind = opts.kind ?? "time";
    const what =
      kind === "time"
        ? `${opts.seconds ?? 5} SECOND TIME PENALTY`
        : kind === "drive-through"
          ? "DRIVE THROUGH PENALTY"
          : "STOP-AND-GO PENALTY";
    return this.rc(`FIA STEWARDS: ${what} FOR ${this.car(num)}${opts.reason ? ` - ${opts.reason}` : ""}`);
  }

  /** Incidente bajo investigación, anotado o revisado. */
  steward(
    num: string,
    status: "NOTED" | "UNDER INVESTIGATION" | "REVIEWED NO FURTHER INVESTIGATION" | "WILL BE INVESTIGATED AFTER THE RACE",
    reason?: string,
  ): this {
    const prefix = status === "NOTED" ? "" : "FIA STEWARDS: ";
    return this.rc(`${prefix}INCIDENT INVOLVING ${this.car(num)} ${status}${reason ? ` - ${reason}` : ""}`);
  }

  /** Bandera a cuadros y fin de la sesión. */
  finish(): this {
    if (this.finished) throw new Error("la carrera ya terminó");
    this.finished = true;
    this.rc("CHEQUERED FLAG", { category: "Flag", flag: "CHEQUERED", scope: "Track" });
    this.emit("SessionStatus", { Status: "Finished", Started: "Finished" });
    this.emit("SessionStatus", { Status: "Finalised", Started: "Finished" }, this.t + 600_000);
    return this;
  }

  // --- salida ---

  /** Los mensajes ordenados por `ts` (a igual `ts` se respeta el orden de emisión), más un Heartbeat cada 15 s. */
  build(): RawMessage[] {
    const last = this.out.reduce((m, x) => Math.max(m, x.ts), 0);
    const all = [...this.out];
    for (let ts = 15_000; ts <= last; ts += 15_000)
      all.push({ topic: "Heartbeat", ts, data: { Utc: new Date(this.utc0 + ts).toISOString() } });
    return all
      .map((m, i) => [m, i] as const)
      .sort((a, b) => a[0].ts - b[0].ts || a[1] - b[1])
      .map(([m]) => structuredClone(m));
  }
}

/** Una carrera completa y corta, con todo lo que hay que cubrir: sobrepaso, parada, Safety Car, retiro, doblado y sanción. */
export function sampleRace(): RaceBuilder {
  const r = new RaceBuilder({ drivers: 5, laps: 6 });
  const LAP = 90_000;
  r.at(10_000).start();
  // vuelta 1
  for (const [i, n] of ["1", "2", "3", "4", "5"].entries())
    r.at(10_000 + LAP + i * 800).lap(n, LAP + 6_000 + i * 800, { gap: i * 0.8, interval: i === 0 ? undefined : 0.8 });
  // vuelta 2: el 2 pasa al 1 en pista
  r.at(10_000 + 2 * LAP - 30_000).pass("2", "1");
  // vuelta 3: parada del 3, que sale con duros
  r.at(10_000 + 3 * LAP - 12_000).pitIn("3");
  r.after(22_000).pitOut("3", { compound: "HARD" });
  // vuelta 4: Safety Car y un retiro
  r.at(10_000 + 4 * LAP - 40_000).safetyCar();
  r.after(5_000).retire("5");
  r.at(10_000 + 5 * LAP).allClear();
  r.penalty("4", { seconds: 5, reason: "SPEEDING IN THE PIT LANE" });
  r.at(10_000 + 6 * LAP + 5_000).finish();
  return r;
}
