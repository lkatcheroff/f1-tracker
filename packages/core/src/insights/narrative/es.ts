import { type Facts, lapTime, num1 } from "./format";

/**
 * Plantillas en español. Tono sobrio, de cronista. Cada una recibe el evento ya procesado (`Facts`) y sus datos:
 * no hay lógica de negocio acá, solo texto. Para sumar otro idioma se agrega un archivo con la misma forma.
 */

type Data = Record<string, number | string | boolean | null>;

const COMPOUND: Record<string, string> = {
  SOFT: "blandos",
  MEDIUM: "medios",
  HARD: "duros",
  INTERMEDIATE: "intermedios",
  WET: "de lluvia",
};

const PENALTY_TEXT = (d: Data) => {
  switch (d.type) {
    case "time":
      return `${d.seconds} segundos de sanción`;
    case "drive-through":
      return "pasada por boxes";
    case "stop-go":
      return d.seconds ? `stop-and-go de ${d.seconds} segundos` : "stop-and-go";
    default:
      return "advertencia";
  }
};

const reason = (d: Data) => (d.reason ? ` (${String(d.reason).toLowerCase()})` : "");
const lap = (f: Facts) => (f.lap ? `${f.lap} · ` : "");
const places = (n: number) => `${n} ${n === 1 ? "puesto" : "puestos"}`;

export const es = {
  overtake: (f: Facts, d: Data) => `${lap(f)}${f.names[0]} pasa a ${f.names[1]} y queda ${d.toPos}.º.`,
  leadChange: (f: Facts, d: Data) =>
    d.afterPits ? `${lap(f)}${f.names[0]} toma la punta tras las paradas.` : `${lap(f)}${f.names[0]} pasa a ${f.names[1]} y toma la punta.`,
  pit: (f: Facts, d: Data) => {
    const tyre = d.compound ? ` y monta ${COMPOUND[String(d.compound)] ?? String(d.compound).toLowerCase()}` : "";
    const back = d.rejoinPos ? `, vuelve ${d.rejoinPos}.º` : "";
    return `${lap(f)}${f.names[0]} para${tyre}${back} (${num1(Number(d.laneSec))} s en la calle de boxes).`;
  },
  fastestLap: (f: Facts, d: Data) => `${lap(f)}Vuelta rápida de ${f.names[0]}: ${lapTime(Number(d.lapMs))}.`,
  retirement: (f: Facts) => `${lap(f)}${f.names[0]} abandona.`,
  penalty: (f: Facts, d: Data) => `${lap(f)}Sanción para ${f.names[0]}: ${PENALTY_TEXT(d)}${reason(d)}.`,
  investigation: (f: Facts, d: Data) => {
    const who = f.list;
    switch (d.status) {
      case "noted":
        return `${lap(f)}Incidente anotado: ${who}${reason(d)}.`;
      case "investigation":
        return `${lap(f)}Bajo investigación: ${who}${reason(d)}.`;
      case "after-session":
        return `${lap(f)}Se investigará al final: ${who}${reason(d)}.`;
      default:
        return `${lap(f)}Sin sanción para ${who}${reason(d)}.`;
    }
  },
  neutralization: (f: Facts, d: Data) => {
    const what = d.type === "VSC" ? "Safety Car virtual" : d.type === "RED" ? "Bandera roja" : "Safety Car";
    return `${lap(f)}${what}.`;
  },
  start: (f: Facts, d: Data) => {
    const parts: string[] = [];
    if (d.gainDriver && Number(d.gainN) > 0) parts.push(`${f.names[0]} gana ${places(Number(d.gainN))}`);
    if (d.lossDriver && Number(d.lossN) > 0) parts.push(`${f.names[1] ?? f.names[0]} pierde ${places(Number(d.lossN))}`);
    return `Largada: ${parts.join("; ") || "sin cambios"}.`;
  },
  battle: (f: Facts, d: Data) =>
    `${lap(f)}Duelo entre ${f.names[0]} y ${f.names[1]}: ${num1(Number(d.gapSec))} s${d.laps ? ` desde hace ${d.laps} vueltas` : ""}.`,
  undercut: (f: Facts, d: Data) =>
    `${lap(f)}Undercut de ${f.names[0]} sobre ${f.names[1]}: gana ${num1(Number(d.gainSec))} s con la parada.`,
  overcut: (f: Facts, d: Data) =>
    `${lap(f)}Overcut de ${f.names[0]} sobre ${f.names[1]}: gana ${num1(Number(d.gainSec))} s alargando el stint.`,
  failedUndercut: (f: Facts, d: Data) =>
    `${lap(f)}${f.names[0]} para primero pero no le saca ventaja a ${f.names[1]}${d.gainSec ? ` (${num1(Number(d.gainSec))} s)` : ""}.`,
};
