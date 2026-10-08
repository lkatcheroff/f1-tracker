// Aceptación del móvil (SPEC-v2 §5): 390×844, sin desborde horizontal, sincronizar la largada,
// cambiar de pestaña y tocar un evento. Necesita el sitio andando (por defecto, `npm run dev`) y Chrome.
// Uso: npm run e2e:mobile   (E2E_URL, E2E_SESSION y E2E_AT cambian a dónde apunta)
import { launch, MOBILE, openSession } from "./browser";

const browser = await launch();
const page = await browser.newPage({ viewport: MOBILE, hasTouch: true, isMobile: true });
const problems: string[] = [];
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "✓" : "✗"} ${what}`);
  if (!ok) problems.push(what);
};
const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
const clock = () => page.locator(".clock").innerText();

try {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await openSession(page);

  check((await overflow()) <= 0, "la página no se desborda en horizontal (torre)");
  check((await page.locator("[role=tab]").count()) === 5, "hay cinco pestañas");
  check(await page.locator(".tower th.hide-sm").first().isHidden(), "la torre oculta sus columnas secundarias");

  // Tocar un evento de la lista mueve la reproducción.
  await page.getByRole("tab", { name: "Eventos" }).click();
  const rows = page.locator(".event-row");
  if ((await rows.count()) > 0) {
    const before = await clock();
    await rows.first().tap();
    await page.waitForFunction((b) => document.querySelector(".clock")?.textContent !== b, before, { timeout: 5000 }).catch(() => {});
    check((await clock()) !== before, "tocar un evento mueve la reproducción");
  } else check(false, "hay eventos en la pestaña Eventos (probá con E2E_AT más avanzado)");

  // Sincronizar la largada: el reloj pasa a contar desde la largada.
  await page.getByRole("button", { name: "Sync: largada" }).click();
  await page.waitForFunction(() => /desde la largada/.test(document.querySelector(".clock")?.textContent ?? ""));
  check(/desde la largada/.test(await clock()), "Sync: largada deja el reloj contando desde la largada");

  // Cada pestaña muestra algo distinto y ninguna desborda.
  for (const name of ["Mapa", "Gaps", "Eventos", "Telemetría", "Torre"]) {
    await page.getByRole("tab", { name }).click();
    await page.waitForTimeout(400);
    check((await page.getByRole("tab", { name }).getAttribute("aria-selected")) === "true", `pestaña ${name} seleccionada`);
    check((await page.locator("#tab-body *").count()) > 0, `pestaña ${name} tiene contenido`);
    check((await overflow()) <= 0, `pestaña ${name} sin desborde horizontal`);
  }

  // Ajustes plegados: los controles secundarios aparecen al tocar.
  check(await page.getByLabel("Velocidad").isHidden(), "Velocidad está plegada");
  await page.getByRole("button", { name: /Ajustes/ }).click();
  check(await page.getByLabel("Velocidad").isVisible(), "Ajustes despliega la velocidad");
  await page.getByRole("button", { name: /Ajustes/ }).click();

  // Objetivos táctiles de 44 px en todo lo que se toca (los sliders y casillas tienen su propia regla).
  for (const name of ["Torre", "Mapa", "Gaps", "Eventos"]) {
    await page.getByRole("tab", { name }).click();
    await page.waitForTimeout(300);
    const small = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>("button, select, a.btn, .tower tbody tr")]
        .filter((e) => e.offsetParent !== null)
        .map((e) => ({ r: e.getBoundingClientRect(), t: (e.textContent ?? "").trim().slice(0, 24) || e.tagName }))
        .filter(({ r }) => r.width > 0 && r.height < 43.5)
        .map(({ t, r }) => `${t} (${Math.round(r.height)} px)`),
    );
    check(small.length === 0, `objetivos táctiles ≥ 44 px en ${name}${small.length ? `: ${small.slice(0, 5).join(", ")}` : ""}`);
  }
  check(errors.length === 0, `sin errores de JavaScript${errors.length ? `: ${errors[0]}` : ""}`);
} finally {
  await browser.close();
}

if (problems.length) {
  console.error(`\n${problems.length} comprobaciones fallaron`);
  process.exit(1);
}
console.log("\nTodo en orden");
