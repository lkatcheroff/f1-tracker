// Aceptación del móvil (SPEC-v2 §5): 390×844, sin desborde horizontal, sincronizar la largada,
// cambiar de pestaña y tocar un evento. Necesita el sitio andando (por defecto, `npm run dev`) y Chrome.
// Uso: npm run e2e:mobile   (E2E_URL, E2E_SESSION y E2E_AT cambian a dónde apunta)
import { launch, MOBILE, openSession, sessionUrl } from "./browser";

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
  // Clasificación: tiempo restante a la vista, "Ir a" por el tiempo de sesión y barra que sigue al dedo.
  const quali = process.env.E2E_QUALI ?? "static:2026/2026-09-26_Azerbaijan_Grand_Prix/2026-09-25_Qualifying/";
  await page.goto(
    sessionUrl(3300).replace(
      encodeURIComponent(process.env.E2E_SESSION ?? "static:2026/2026-09-26_Azerbaijan_Grand_Prix/2026-09-26_Race/"),
      encodeURIComponent(quali),
    ),
  );
  // La pestaña elegida se recuerda: se vuelve a la torre antes de esperar a que cargue.
  await page.getByRole("tab", { name: "Torre" }).click();
  await page.waitForSelector(".tower tbody tr", { timeout: 60_000 });
  const remaining = page.locator(".remaining");
  check(await remaining.isVisible(), "la clasificación muestra el tiempo restante");
  check(((await remaining.boundingBox())?.height ?? 0) >= 43, "el tiempo restante se puede tocar (≥ 44 px)");
  const readout = async () => (await page.locator(".remaining-time").innerText()).trim();
  await remaining.tap();
  await page.locator(".goto-input").fill("3:15");
  await page.getByRole("button", { name: "Ir", exact: true }).tap();
  await page.waitForTimeout(1200);
  check((await readout()) === "03:15", `"Ir a" faltando 3:15 deja el reloj en 03:15 (muestra ${await readout()})`);
  check((await page.locator(".remaining-label").innerText()).includes("Q2"), "...y en la parte correcta (Q2)");
  await remaining.tap();
  await page.locator(".goto-input").fill("99:00");
  await page.getByRole("button", { name: "Ir", exact: true }).tap();
  check(await page.getByRole("alert").isVisible(), "un tiempo que no existe avisa en vez de saltar");
  await remaining.tap();

  // La barra sigue al dedo: sin soltar, la reproducción ya se mueve.
  const before = await readout();
  await page.locator(".scrub").evaluate((el: HTMLInputElement) => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    set?.call(el, String(Math.round(Number(el.max) * 0.3)));
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.waitForTimeout(500);
  check((await readout()) !== before, "arrastrar la barra mueve la reproducción antes de soltar");
  check((await page.locator(".drag-label").innerText()).includes("faltan"), "mientras se arrastra, se ve cuánto faltaría en ese punto");

  check(errors.length === 0, `sin errores de JavaScript${errors.length ? `: ${errors[0]}` : ""}`);
} finally {
  await browser.close();
}

if (problems.length) {
  console.error(`\n${problems.length} comprobaciones fallaron`);
  process.exit(1);
}
console.log("\nTodo en orden");
