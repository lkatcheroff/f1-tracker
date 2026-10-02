/** Mensaje crudo del feed de F1, igual en replay y en live. */
export type RawMessage = {
  topic: string;
  data: unknown;
  /** ms desde el inicio del stream (replay) o epoch ms (live). */
  ts: number;
};

/** Fuente en vivo. El replay no es un stream: lo maneja `ReplayPlayer` sobre la lista completa de mensajes. */
export interface DataSource {
  start(): AsyncIterable<RawMessage>;
}

export interface TimedValue {
  value: string;
  /** mejor personal */
  pb: boolean;
  /** mejor absoluto */
  ob: boolean;
}

export interface Tyre {
  compound: string;
  /** vueltas del juego de neumáticos */
  age: number;
  isNew: boolean;
}

export interface DriverRow {
  num: string;
  tla: string;
  name: string;
  team: string;
  /** hex sin `#` */
  color: string;
  position: number;
  /** Texto tal cual lo manda F1: "+12.345", "LAP 14", "1L", "". */
  gap: string;
  interval: string;
  /** Gap al líder en segundos; 0 para el líder, null si no es numérico (vueltas perdidas, sin dato). */
  gapSec: number | null;
  catching: boolean;
  lastLap: TimedValue;
  bestLap: string;
  sectors: TimedValue[];
  laps: number;
  pits: number;
  inPit: boolean;
  pitOut: boolean;
  retired: boolean;
  stopped: boolean;
  knockedOut: boolean;
  tyre: Tyre | null;
  /** Posición en pista (unidades del feed, 1/10 m). Si el auto deja de transmitir, queda la última conocida. */
  xy: [number, number] | null;
  onTrack: boolean;
  lapState: LapState;
}

/**
 * Qué está haciendo el auto en la vuelta en curso, según sus mini-sectores:
 * en boxes, vuelta de salida/entrada, mejorando su marca (green), marcando récords (purple),
 * vuelta normal (lap) o sin datos (null).
 */
export type LapState = "pit" | "out" | "purple" | "green" | "lap" | null;

export interface RaceControlMessage {
  utc: string;
  lap: number | null;
  category: string;
  flag: string | null;
  /** "Track" | "Sector" | "Driver" */
  scope: string | null;
  /** sector de banderilleros, cuando `scope` es "Sector" */
  sector: number | null;
  /** nº de auto, cuando `scope` es "Driver" (banderas azules) */
  driver: string | null;
  message: string;
}

export interface Weather {
  air: number | null;
  track: number | null;
  humidity: number | null;
  rain: boolean;
  windSpeed: number | null;
  windDir: number | null;
}

export interface SessionMeta {
  meeting: string;
  name: string;
  type: string;
  circuit: string;
  country: string;
  path: string | null;
  /** clave del circuito en el feed (sirve para pedir curvas y sectores de banderilleros) */
  circuitKey: number | null;
  year: number | null;
}

export interface TopicHealth {
  count: number;
  /** ts del último mensaje del topic */
  lastTs: number;
}

export interface Snapshot {
  time: number;
  /** epoch ms estimado del instante de sesión (de Heartbeat), si se conoce */
  utc: number | null;
  session: SessionMeta | null;
  /** Inactive | Started | Aborted | Finished | Finalised | Ends */
  status: string;
  track: { status: string; message: string };
  lap: { current: number; total: number } | null;
  /** Tiempo restante de sesión en ms (ExtrapolatedClock). */
  remainingMs: number | null;
  /** Q1/Q2/Q3 en clasificación */
  part: number | null;
  weather: Weather | null;
  drivers: DriverRow[];
  raceControl: RaceControlMessage[];
  /** Sectores de banderilleros con bandera amarilla en este momento. */
  yellowSectors: { sector: number; double: boolean }[];
  /** Autos de seguridad que el feed ubica en pista mientras están desplegados. */
  safetyCars: { id: string; xy: [number, number] }[];
  topics: Record<string, TopicHealth>;
}

/** Muestra del gráfico de gaps. */
export interface GapSample {
  t: number;
  lap: number | null;
  gaps: Record<string, number | null>;
}

export interface TrackOutline {
  /** Una vuelta completa; el primer punto es la línea de meta. */
  points: [number, number][];
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
  /** Dónde empiezan los sectores 2 y 3 (posición del auto al marcar S1 y S2). */
  marks?: { s2?: [number, number]; s3?: [number, number] };
  /** Calle de boxes, de la entrada a la salida (recorrido de un auto durante una parada). */
  pit?: [number, number][];
}

/** Índice de una sesión grabada, para navegar el replay. */
export interface SessionIndex {
  duration: number;
  /** ts de cada paso a `Started` (largada, relargadas, Q1/Q2/Q3). */
  starts: number[];
  totalLaps: number | null;
  laps: { lap: number; ts: number }[];
  /** Cambios de estado de pista y de sesión, para marcar la línea de tiempo. */
  events: { ts: number; kind: "track" | "session"; value: string }[];
}
