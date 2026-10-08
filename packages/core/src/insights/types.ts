/** Tipos del análisis de carrera (`buildInsights`). Todos los `ts` están en el mismo eje que `RawMessage.ts`. */

export type EventKind =
  | "start" // resumen de la largada (posiciones ganadas y perdidas contra la grilla)
  | "overtake" // sobrepaso en pista
  | "leadChange"
  | "pit" // parada completa
  | "fastestLap"
  | "retirement"
  | "penalty" // sanción anunciada por Race Control
  | "investigation" // incidente anotado, bajo investigación o revisado
  | "neutralization" // Safety Car, Safety Car virtual o bandera roja
  | "battle" // duelo
  | "undercut"
  | "overcut";

export interface InsightEvent {
  /** estable: `${kind}:${ts}:${drivers.join("-")}` */
  id: string;
  kind: EventKind;
  /** momento en que el evento queda RESUELTO: lo que decide cuándo se puede mostrar sin spoilear */
  ts: number;
  /** adonde salta el clic (<= ts) */
  seekTs: number;
  lap: number | null;
  /** nº de auto, el protagonista primero */
  drivers: string[];
  data: Record<string, number | string | boolean | null>;
  /** "approx" cuando el dato sale de una reconstrucción (por ejemplo, un abandono deducido) */
  confidence: "high" | "approx";
}

export interface LapRow {
  driver: string;
  lap: number;
  /** cuándo arrancó la vuelta (cruce de meta anterior; en la vuelta 1, la largada) */
  startTs: number;
  /** cuándo se completó */
  endTs: number;
  lapTimeMs: number | null;
  /** al cierre de la vuelta (leído `LAP_SETTLE_MS` después, cuando el feed termina de actualizar) */
  position: number | null;
  /** null si va a una o más vueltas; en práctica y clasificación, la diferencia con el mejor tiempo */
  gapLeaderSec: number | null;
  intervalSec: number | null;
  /** neumático al cierre; la edad cuenta vueltas del juego, incluidas las que traía */
  tyre: { compound: string; age: number; isNew: boolean } | null;
  /** nº de stint del piloto (0 = el de salida) */
  stint: number;
  /** entró a boxes en esta vuelta */
  inLap: boolean;
  /** salió de boxes en esta vuelta */
  outLap: boolean;
  /** Safety Car, Safety Car virtual o bandera roja durante la vuelta */
  neutralized: boolean;
  /** bandera amarilla en algún sector durante la vuelta */
  yellow: boolean;
  sectorsMs: [number | null, number | null, number | null];
}

export interface Stint {
  driver: string;
  index: number;
  compound: string;
  isNew: boolean;
  lapStart: number;
  lapEnd: number;
  rows: LapRow[];
}

/** Cómo se clasificó cada cambio de posición. Cada uno cae en exactamente una clase. */
export type ChangeClass = "pitCycle" | "retirement" | "start" | "neutralized" | "penalty" | "onTrack";

/** Un auto (`passer`) quedó delante de otro (`passed`), ya descontados los rebotes. */
export interface PositionChange {
  /** cuándo el orden quedó estable */
  ts: number;
  /** cuándo cambió el orden en el feed */
  flipTs: number;
  passer: string;
  passed: string;
  /** posición que ocupa el que pasó, ya con el cambio */
  toPos: number;
  class: ChangeClass;
  /** vuelta en curso del que pasó */
  lap: number | null;
}

export interface DataQuality {
  source: "official" | "openf1" | "recording";
  hasPositions: boolean;
  hasTelemetry: boolean;
  /** lo que esta fuente aproxima o no trae, para avisarlo en pantalla */
  approximations: string[];
}

export interface DriverInfo {
  tla: string;
  name: string;
  team: string;
  color: string;
}

export interface SessionInsights {
  isRace: boolean;
  /** largada (SessionStatus → Started) y bandera a cuadros, si ya ocurrieron */
  startTs: number | null;
  endTs: number | null;
  drivers: Record<string, DriverInfo>;
  /** posición de grilla y posición final (la última conocida) por piloto */
  grid: Record<string, number>;
  final: Record<string, number>;
  laps: LapRow[];
  stints: Stint[];
  events: InsightEvent[];
  /** todos los cambios de posición, con su clase (los sobrepasos son los `onTrack`) */
  changes: PositionChange[];
  dataQuality: DataQuality;
}

export type DataSourceKind = DataQuality["source"];
