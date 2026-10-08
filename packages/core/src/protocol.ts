import type { SessionInsights } from "./insights";
import type { GapSample, SessionIndex, Snapshot, TopicHealth, TrackOutline } from "./types";

/** Protocolo del WebSocket propio entre server y web. */

export type ClientCommand =
  /** `source`: "static:<path>" | "rec:<archivo>" | "openf1:<inicio de la sesión en UTC>" | "mirror:<archivo>" */
  | { type: "open"; mode: "replay"; source: string; at?: number }
  | { type: "open"; mode: "live" }
  | { type: "play" }
  | { type: "pause" }
  | { type: "seek"; ts: number }
  | { type: "speed"; x: number };

export interface PlaybackState {
  time: number;
  paused: boolean;
  speed: number;
}

export type LiveStatus = "connecting" | "connected" | "reconnecting" | "closed";

export interface LiveState {
  status: LiveStatus;
  detail: string;
  /** topics pedidos en el Subscribe */
  subscribed: string[];
  /** topics que vinieron con datos en el estado inicial */
  initial: string[];
  /** mensajes crudos recibidos por topic (estado inicial + incrementales) */
  topics: Record<string, TopicHealth>;
  recording: string | null;
}

export type ServerMessage =
  | { type: "loading"; step: string }
  | { type: "opened"; mode: "replay"; source: string; index: SessionIndex; outline: TrackOutline | null; insights: SessionInsights | null }
  | { type: "opened"; mode: "live" }
  | { type: "outline"; outline: TrackOutline }
  | { type: "snapshot"; snap: Snapshot; playback?: PlaybackState; live?: LiveState }
  | { type: "history"; reset: boolean; points: GapSample[] }
  | { type: "error"; message: string };

export interface SessionEntry {
  key: number;
  name: string;
  type: string;
  /** ISO en UTC */
  startUtc: string;
  endUtc: string;
  /** path en el archivo estático de F1; null si todavía no está publicado */
  path: string | null;
  /** Solo en el sitio estático: archivo con la sesión ya procesada, relativo a `data/`. */
  data?: string | null;
}

export interface MeetingEntry {
  key: number;
  name: string;
  location: string;
  country: string;
  sessions: SessionEntry[];
}

export interface RecordingEntry {
  file: string;
  label: string;
  sizeKb: number;
  modified: string;
}

export interface SessionsResponse {
  year: number;
  meetings: MeetingEntry[];
  recordings: RecordingEntry[];
}
