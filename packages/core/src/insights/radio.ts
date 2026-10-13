/**
 * La radio del equipo es un mp3 en el archivo de F1: `.../static/<año>/<fin de semana>/<sesión>/TeamRadio/<archivo>.mp3`.
 * Las transcripciones se guardan en un archivo por sesión, y tanto la herramienta que las genera como la página que
 * las lee ubican ese archivo y cada mensaje con estas dos funciones, sin necesitar nada más que la dirección del audio.
 */
const RE = /\/static\/(.+)\/TeamRadio\/([^/?#]+\.mp3)(?:[?#].*)?$/i;

/** Identificador de un mensaje dentro de su sesión: el nombre del archivo (`ALB_23_20261011_195602.mp3`). */
export function radioId(url: string): string | null {
  return RE.exec(url)?.[2] ?? null;
}

/** Nombre del archivo de transcripciones de la sesión a la que pertenece el audio. */
export function radioTranscriptFile(url: string): string | null {
  const folder = RE.exec(url)?.[1];
  return folder ? `${folder.replaceAll("/", "__")}.json` : null;
}

/** Lo que se guarda por mensaje. `text` vacío = no se entendió o no hay voz: no se vuelve a intentar. */
export interface RadioTranscript {
  text: string;
  /** idioma detectado */
  lang: string;
}

export type RadioTranscripts = Record<string, RadioTranscript>;
