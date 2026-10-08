import type { DriverInfo, InsightEvent } from "../types";
import { es } from "./es";
import { type Facts, joinList, shortName } from "./format";

export { lapTime, shortName } from "./format";

export type Locale = "es";

export interface NarrativeContext {
  drivers: Record<string, DriverInfo>;
}

const TEMPLATES = { es };

/**
 * La frase de un evento. Depende solo del evento y de los nombres de los pilotos: nunca consulta nada posterior,
 * así que un evento visible en `now` se cuenta igual que se contaría al final de la sesión.
 */
export function describe(event: InsightEvent, ctx: NarrativeContext, locale: Locale = "es"): string {
  const names = event.drivers.map((n) => shortName(ctx.drivers[n], n));
  const facts: Facts = { lap: event.lap ? `V${event.lap}` : "", names, list: joinList(names, "y") };
  const t = TEMPLATES[locale];
  switch (event.kind) {
    case "undercut":
      return event.data.success === false ? t.failedUndercut(facts, event.data) : t.undercut(facts, event.data);
    default:
      return t[event.kind](facts, event.data);
  }
}
