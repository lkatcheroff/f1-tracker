import type { RadioTranscripts } from "@f1/core";

/**
 * Servicio local de transcripción (scripts/radio-helper.ts): corre en la compu del usuario, si lo instaló.
 * La página lo busca al mostrar la radio de una sesión; si no está, todo sigue igual, sin avisos.
 */
const BASE = "http://127.0.0.1:8788";

let probe: { at: number; result: Promise<boolean> } | null = null;

/** ¿Hay un servicio local andando? Se recuerda la respuesta 30 segundos para no insistir. */
export function helperAvailable(): Promise<boolean> {
  if (probe && Date.now() - probe.at < 30_000) return probe.result;
  const result = fetch(`${BASE}/health`, { signal: AbortSignal.timeout(1500) })
    .then((res) => res.ok)
    .catch(() => false);
  probe = { at: Date.now(), result };
  return result;
}

/** Pide que se transcriban estos mensajes. Devuelve cuántos quedaron pendientes. */
export async function requestTranscripts(clips: string[], drivers: string[]): Promise<number> {
  const res = await fetch(`${BASE}/transcribe`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ clips, drivers }),
  });
  if (!res.ok) throw new Error(`el servicio local respondió HTTP ${res.status}`);
  return ((await res.json()) as { pending: number }).pending;
}

/** Lo que el servicio tiene de una sesión y cuánto le falta. */
export async function helperTexts(file: string): Promise<{ pending: number; texts: RadioTranscripts }> {
  const res = await fetch(`${BASE}/texts?file=${encodeURIComponent(file)}`);
  if (!res.ok) throw new Error(`el servicio local respondió HTTP ${res.status}`);
  return res.json();
}
