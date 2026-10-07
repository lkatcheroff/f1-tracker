import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { RawMessage } from "@f1/core";
import { findOpenF1Session, loadOpenF1Session as fetchSession } from "@f1/openf1";
import { cacheDir } from "./config";

/** Fallback OpenF1 con caché en disco: la sesión entera se baja una sola vez. */
export async function loadOpenF1Session(startUtc: string, onStep: (s: string) => void): Promise<RawMessage[]> {
  onStep("buscando la sesión en OpenF1");
  const session = await findOpenF1Session(startUtc);
  // `.car`: este caché incluye la telemetría, a diferencia de los anteriores.
  const cacheFile = path.join(cacheDir("openf1"), `${session.key}.car.json`);
  try {
    return JSON.parse(await readFile(cacheFile, "utf8"));
  } catch {
    // sin caché
  }
  const messages = await fetchSession(startUtc, onStep, { withCar: true });
  // Solo se cachea una sesión ya cerrada: antes, OpenF1 puede seguir completando datos.
  if (Date.now() > Date.parse(session.endUtc) + 3 * 3600_000) {
    await mkdir(path.dirname(cacheFile), { recursive: true });
    await writeFile(cacheFile, JSON.stringify(messages));
  }
  return messages;
}
