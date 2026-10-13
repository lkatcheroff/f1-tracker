import type { RawMessage } from "./types";

/**
 * Reloj de la sesión (el cronómetro de práctica y clasificación), reconstruido de los mensajes `ExtrapolatedClock`.
 * El feed manda anclas: "en este instante faltan X, y corre / está detenido". Entre dos anclas, si corre,
 * el tiempo restante baja a la par del reloj. Con eso se calcula cuánto falta en cualquier momento y,
 * al revés, en qué momento de la grabación faltaban X (para "ir a cuando faltan 3:15 de la Q2").
 */
export interface ClockAnchor {
  /** momento de la grabación (ms desde el inicio del stream) */
  ts: number;
  /** lo que faltaba en ese momento */
  remainingMs: number;
  /** si el reloj corría a partir de ahí; detenido = bandera roja o entre partes */
  running: boolean;
  /** parte de la clasificación en la que cae el tramo que empieza en esta ancla (null en práctica) */
  part: number | null;
}

export interface ClockReading {
  remainingMs: number;
  running: boolean;
  part: number | null;
}

/** "00:17:59" → ms. Acepta "H:MM:SS" y "MM:SS". */
export function parseClockText(text: unknown): number | null {
  if (typeof text !== "string") return null;
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:\.\d+)?$/.exec(text.trim());
  return m ? ((Number(m[1] ?? 0) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000 : null;
}

/**
 * Lo que escribe una persona: "3:15" son 3 minutos y 15 segundos; "1:03:15", una hora; un número solo, minutos ("3" = 3:00).
 * Devuelve null si no se entiende.
 */
export function parseRemainingInput(text: string): number | null {
  const t = text.trim().replace(",", ".");
  if (/^\d+(\.\d+)?$/.test(t)) return Math.round(Number(t) * 60_000);
  const parts = t.split(":");
  if (parts.length < 2 || parts.length > 3 || parts.some((p) => !/^\d+$/.test(p))) return null;
  const n = parts.map(Number);
  if (n.slice(1).some((v) => v > 59)) return null;
  return (n.length === 3 ? n[0] * 3600 + n[1] * 60 + n[2] : n[0] * 60 + n[1]) * 1000;
}

export function buildClock(messages: RawMessage[]): ClockAnchor[] {
  const raw: { ts: number; remainingMs: number; running: boolean }[] = [];
  const partChanges: { ts: number; part: number }[] = [];
  let last = { remainingMs: 0, running: false };
  for (const m of messages) {
    const d = m.data as Record<string, any> | undefined;
    if (m.topic === "ExtrapolatedClock" && d) {
      const remaining = parseClockText(d.Remaining);
      // Los mensajes son deltas: lo que no viene sigue como estaba.
      const running = typeof d.Extrapolating === "boolean" ? d.Extrapolating : last.running;
      if (remaining === null && typeof d.Extrapolating !== "boolean") continue;
      last = { remainingMs: remaining ?? last.remainingMs, running };
      raw.push({ ts: m.ts, ...last });
    } else if (m.topic === "TimingData" && typeof d?.SessionPart === "number" && d.SessionPart > 0) {
      partChanges.push({ ts: m.ts, part: d.SessionPart });
    }
  }
  const partAt = (ts: number): number | null => {
    let part: number | null = null;
    for (const c of partChanges) {
      if (c.ts > ts) break;
      part = c.part;
    }
    return part;
  };
  // Un tramo en marcha, o el cierre de una parte (reloj en cero), pertenece a la parte vigente en su ancla.
  // Un reinicio detenido (el reloj vuelve a 15:00 antes de anunciarse la Q2) pertenece a la parte que viene: la del final del tramo.
  return raw.map((a, i) => ({
    ...a,
    part: a.running || a.remainingMs === 0 ? partAt(a.ts) : partAt(raw[i + 1]?.ts ?? Number.POSITIVE_INFINITY),
  }));
}

/** Cuánto faltaba (y si corría el reloj) en el momento `ts`. `null` antes de la primera ancla. */
export function remainingAt(clock: ClockAnchor[], ts: number): ClockReading | null {
  let a: ClockAnchor | null = null;
  for (const c of clock) {
    if (c.ts > ts) break;
    a = c;
  }
  if (!a) return null;
  return { remainingMs: a.running ? Math.max(0, a.remainingMs - (ts - a.ts)) : a.remainingMs, running: a.running, part: a.part };
}

/** Partes con reloj, en orden (vacío en práctica, donde no hay partes). */
export function clockParts(clock: ClockAnchor[]): number[] {
  return [...new Set(clock.map((a) => a.part).filter((p): p is number => p !== null))].sort((a, b) => a - b);
}

/** Lo más que dura (en ms de reloj) la parte `part`: el tiempo desde el que se puede elegir. */
export function partLength(clock: ClockAnchor[], part: number | null): number {
  return Math.max(0, ...clock.filter((a) => a.part === part).map((a) => a.remainingMs));
}

/**
 * En qué momento de la grabación faltaban `remainingMs` en la parte `part` (null en práctica).
 * Si hubo bandera roja y el reloj se detuvo en ese valor, devuelve el primer instante. `null` si no existe ese momento.
 */
export function tsAtRemaining(clock: ClockAnchor[], part: number | null, remainingMs: number, endTs: number): number | null {
  const TOL = 1500; // el reloj oficial avanza de a segundo: el arranque exacto (15:00) está en un ancla detenida
  let stopped: number | null = null;
  for (let i = 0; i < clock.length; i++) {
    const a = clock[i];
    if (a.part !== part) continue;
    const to = clock[i + 1]?.ts ?? endTs;
    if (a.running) {
      const lowest = Math.max(0, a.remainingMs - (to - a.ts));
      if (remainingMs <= a.remainingMs && remainingMs >= lowest) return Math.round(a.ts + (a.remainingMs - remainingMs));
    } else if (stopped === null && Math.abs(a.remainingMs - remainingMs) <= TOL) stopped = a.ts;
  }
  return stopped;
}
