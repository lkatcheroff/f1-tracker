/**
 * Lectura de los mensajes de Race Control sobre sanciones e incidentes.
 *
 * El piloto va solo en el texto (0 de 61 sanciones de tiempo traen `RacingNumber`). Formatos verificados en las
 * 21 carreras de 2026 (ver docs/spikes.md §7):
 *   FIA STEWARDS: 5 SECOND TIME PENALTY FOR CAR 14 (ALO) - SPEEDING IN THE PIT LANE (15:34:00)
 *   FIA STEWARDS: DRIVE THROUGH PENALTY FOR CAR 41 (LIN) - YELLOW FLAG INFRINGEMENT (15:04:49)
 *   FIA STEWARDS: STOP-AND-GO PENALTY FOR CAR 43 (COL) - STARTING PROCEDURE INFRINGEMENT
 *   FIA STEWARDS: PENALTY SERVED - STOP-AND-GO PENALTY FOR CAR 43 (COL) - ...
 *   FIA STEWARDS: WARNING FOR CAR 55 (SAI) - STARTING PROCEDURE INFRINGEMENT - OUT OF POSITION ...
 *   INCIDENT INVOLVING CARS 11 (PER) AND 14 (ALO) NOTED - CAUSING A COLLISION (12:05:54)
 *   FIA STEWARDS: TURN 3 INCIDENT INVOLVING CARS 11 (PER) AND 14 (ALO) UNDER INVESTIGATION - CAUSING A COLLISION
 *   FIA STEWARDS: INCIDENT INVOLVING CAR 31 (OCO) WILL BE INVESTIGATED AFTER THE RACE - DRIVING UNNECESSARILY SLOWLY
 *   FIA STEWARDS: INCIDENT INVOLVING CAR 12 (ANT) REVIEWED NO FURTHER INVESTIGATION | NO FURTHER ACTION
 * Variantes: prefijos `UPDATE:`, `TURN n`, `LAP n TURN n`; varios autos; motivo y hora opcionales.
 */

export type PenaltyType = "time" | "drive-through" | "stop-go" | "warning";
export type InvestigationStatus = "noted" | "investigation" | "after-session" | "cleared";

export type Steward =
  | {
      kind: "penalty";
      type: PenaltyType;
      drivers: string[];
      tlas: string[];
      seconds: number | null;
      served: boolean;
      reason: string | null;
    }
  | { kind: "investigation"; status: InvestigationStatus; drivers: string[]; tlas: string[]; turn: number | null; reason: string | null };

const CARS = /\bCARS?\s+(\d+\s*\([A-Z]{3}\)(?:(?:\s*,\s*|\s+AND\s+)\d+\s*\([A-Z]{3}\))*)/;
const ONE_CAR = /(\d+)\s*\(([A-Z]{3})\)/g;

function carsOf(text: string): { drivers: string[]; tlas: string[] } {
  const seq = CARS.exec(text)?.[1] ?? "";
  const drivers: string[] = [];
  const tlas: string[] = [];
  for (const m of seq.matchAll(ONE_CAR)) {
    drivers.push(m[1]);
    tlas.push(m[2]);
  }
  return { drivers, tlas };
}

/** El motivo es lo que sigue al primer " - " tras el piloto o el estado, sin la hora final `(HH:MM:SS)`. */
function reasonOf(text: string): string | null {
  const i = text.indexOf(" - ");
  if (i < 0) return null;
  const reason = text
    .slice(i + 3)
    .replace(/\s*\(\d{1,2}:\d{2}:\d{2}\)\s*$/, "")
    .trim();
  return reason || null;
}

/** null si el mensaje no es una sanción ni un incidente de los comisarios. */
export function parseSteward(message: string): Steward | null {
  const text = message
    .toUpperCase()
    .replace(/^FIA STEWARDS:\s*/, "")
    .replace(/^UPDATE:\s*/, "")
    .trim();
  const served = text.startsWith("PENALTY SERVED");
  const body = served ? text.replace(/^PENALTY SERVED\s*-\s*/, "") : text;

  const time = /^(\d+)\s+SECOND\s+TIME PENALTY FOR\b/.exec(body);
  if (time) return penalty("time", +time[1], body, served);
  if (/^DRIVE[ -]THROUGH PENALTY FOR\b/.test(body)) return penalty("drive-through", null, body, served);
  const stopGo = /^(?:(\d+)\s+SECOND\s+)?STOP[ -]AND[ -]GO PENALTY FOR\b/.exec(body);
  if (stopGo) return penalty("stop-go", stopGo[1] ? +stopGo[1] : null, body, served);
  if (/^WARNING FOR\b/.test(body)) return penalty("warning", null, body, served);

  if (/\bINCIDENT INVOLVING\b/.test(body)) {
    let status: InvestigationStatus | null = null;
    if (/\bUNDER INVESTIGATION\b/.test(body)) status = "investigation";
    else if (/\bWILL BE INVESTIGATED AFTER THE (RACE|SPRINT|SESSION)\b/.test(body)) status = "after-session";
    else if (/\bREVIEWED NO FURTHER INVESTIGATION\b|\bNO FURTHER ACTION\b/.test(body)) status = "cleared";
    else if (/\bNOTED\b/.test(body)) status = "noted";
    if (!status) return null;
    const turn = /\bTURN (\d+)\b/.exec(body)?.[1];
    return { kind: "investigation", status, ...carsOf(body), turn: turn ? +turn : null, reason: reasonOf(body) };
  }
  return null;
}

function penalty(type: PenaltyType, seconds: number | null, body: string, served: boolean): Steward {
  return { kind: "penalty", type, ...carsOf(body), seconds, served, reason: reasonOf(body) };
}
