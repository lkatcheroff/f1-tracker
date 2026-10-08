import type { DriverInfo } from "../types";

/** Datos ya formateados para las plantillas: las plantillas no calculan ni consultan nada. */
export interface Facts {
  /** vuelta, p. ej. "V22" (vacío si no hay) */
  lap: string;
  /** nombre corto del protagonista y de los demás, en el orden del evento */
  names: string[];
  /** nombres unidos para una lista: "Pérez, Gasly y Norris" */
  list: string;
}

/** "Lando NORRIS" → "Norris". Si no hay un apellido en mayúsculas, el nombre completo. */
export function shortName(info: DriverInfo | undefined, num: string): string {
  if (!info) return `#${num}`;
  const caps = info.name.split(/\s+/).filter((w) => w.length > 1 && w === w.toUpperCase() && /[A-ZÁÉÍÓÚÑ]/.test(w));
  const surname = caps.length ? caps.join(" ") : info.name;
  return surname.toLowerCase().replace(/(^|[\s'-])(\p{L})/gu, (_m, sep: string, c: string) => sep + c.toUpperCase());
}

/** 1.8 → "1,8" */
export const num1 = (n: number) => n.toFixed(1).replace(".", ",");

/** 104916 → "1:44.916" */
export function lapTime(ms: number): string {
  const m = Math.floor(ms / 60000);
  return `${m}:${((ms - m * 60000) / 1000).toFixed(3).padStart(6, "0")}`;
}

export function joinList(items: string[], and: string): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} ${and} ${items[items.length - 1]}`;
}
