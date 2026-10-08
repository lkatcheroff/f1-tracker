// Capturas para el README: escritorio y móvil, de una carrera ya avanzada.
// Necesita el sitio andando (por defecto, `npm run dev` con los datos locales) y Chrome. No corre en CI.
// Uso: npm run screenshots   (E2E_URL, E2E_SESSION y E2E_AT cambian a dónde apunta)
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { DESKTOP, launch, MOBILE, openSession } from "./browser";

const out = path.resolve("docs/img");
await mkdir(out, { recursive: true });
const browser = await launch();

try {
  // Escritorio: ancho completo, con la barra de eventos y los paneles de la carrera.
  const desktop = await browser.newPage({ viewport: DESKTOP, deviceScaleFactor: 2 });
  await openSession(desktop);
  await desktop.waitForTimeout(1500);
  await desktop.screenshot({ path: path.join(out, "desktop-race.png") });
  console.log("docs/img/desktop-race.png");

  const events = desktop.locator(".panel", { has: desktop.locator(".event-row") }).first();
  if (await events.count()) {
    await events.scrollIntoViewIfNeeded();
    await events.screenshot({ path: path.join(out, "desktop-events.png") });
    console.log("docs/img/desktop-events.png");
  }
  await desktop.close();

  // Móvil: una captura por pestaña.
  const phone = await browser.newPage({ viewport: MOBILE, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
  await openSession(phone);
  for (const [tab, file] of [
    ["Torre", "mobile-tower.png"],
    ["Mapa", "mobile-map.png"],
    ["Eventos", "mobile-events.png"],
  ] as const) {
    await phone.getByRole("tab", { name: tab }).click();
    await phone.waitForTimeout(1200);
    await phone.screenshot({ path: path.join(out, file) });
    console.log(`docs/img/${file}`);
  }
} finally {
  await browser.close();
}
