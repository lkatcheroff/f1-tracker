// Utilidades compartidas por las pruebas en navegador (`e2e-mobile.ts`) y las capturas (`screenshots.ts`).
// Usan el Chrome instalado en la máquina (playwright-core no baja navegadores). No corren en CI.
import { type Browser, chromium, type Page } from "playwright-core";

export const BASE = process.env.E2E_URL ?? "http://localhost:5173";
/** Sesión a abrir: por defecto, una carrera del archivo local. En el sitio publicado, pasar `E2E_SESSION`. */
export const SESSION = process.env.E2E_SESSION ?? "static:2026/2026-09-26_Azerbaijan_Grand_Prix/2026-09-26_Race/";
/** Segundo de la sesión donde abrir: con la carrera avanzada ya hay eventos y vueltas. */
export const AT = Number(process.env.E2E_AT ?? 5400);

export const sessionUrl = (at = AT) => `${BASE}/#/replay/${encodeURIComponent(SESSION)}?t=${at}`;

export async function launch(): Promise<Browser> {
  try {
    return await chromium.launch({ channel: "chrome" });
  } catch (err) {
    throw new Error(
      `No se pudo abrir Chrome (${err instanceof Error ? err.message : err}). Instalá Google Chrome o apuntá PLAYWRIGHT a otro ejecutable.`,
    );
  }
}

/** Abre la sesión y espera a que la torre tenga pilotos. */
export async function openSession(page: Page, at = AT): Promise<void> {
  await page.goto(sessionUrl(at));
  await page.waitForSelector(".tower tbody tr", { timeout: 60_000 });
}

export const MOBILE = { width: 390, height: 844 };
export const DESKTOP = { width: 1440, height: 900 };
