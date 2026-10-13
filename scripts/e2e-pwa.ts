// Comprobación de la app instalable (Android): manifiesto, íconos, service worker y apertura sin conexión.
// Necesita el sitio estático servido (npm run build:pages && npx vite preview --outDir apps/web/dist) y Chrome. No corre en CI.
// Uso: E2E_URL=http://localhost:4173 npm run e2e:pwa
import { launch, MOBILE } from "./browser";

const URL_ = process.env.E2E_URL ?? "http://localhost:4173";
const browser = await launch();
const context = await browser.newContext({ viewport: MOBILE, hasTouch: true, isMobile: true });
const page = await context.newPage();
const problems: string[] = [];
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "✓" : "✗"} ${what}`);
  if (!ok) problems.push(what);
};

try {
  await page.goto(URL_);
  await page.waitForSelector("h1");

  // Manifiesto
  const href = await page.locator("link[rel=manifest]").getAttribute("href");
  check(!!href, "la página enlaza un manifiesto");
  const manifest = await (await page.request.get(new URL(href ?? "manifest.webmanifest", page.url()).href)).json();
  check(manifest.display === "standalone", "se abre en pantalla completa (standalone)");
  check(!!manifest.name && !!manifest.short_name, "tiene nombre y nombre corto");
  check(manifest.start_url === "./" && manifest.scope === "./", "start_url y scope son relativos (sirven bajo /f1-tracker/)");
  const sizes = new Set(manifest.icons.map((i: { sizes: string }) => i.sizes));
  check(sizes.has("192x192") && sizes.has("512x512"), "tiene íconos de 192 y 512");
  check(
    manifest.icons.some((i: { purpose: string }) => i.purpose === "maskable"),
    "tiene un ícono maskable",
  );
  for (const icon of manifest.icons as { src: string }[]) {
    const res = await page.request.get(new URL(icon.src, new URL(href ?? "", page.url())).href);
    check(res.ok() && (res.headers()["content-type"] ?? "").includes("image/png"), `el ícono ${icon.src} responde como PNG`);
  }
  check((await page.locator("meta[name=theme-color]").count()) === 1, "define theme-color");

  // Service worker
  const active = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.ready;
    return !!reg.active;
  });
  check(active, "el service worker quedó activo");

  // Criterios de instalación de Chrome
  const cdp = await context.newCDPSession(page);
  const { installabilityErrors } = (await cdp.send("Page.getInstallabilityErrors")) as { installabilityErrors: { errorId: string }[] };
  // El contexto de prueba es de incógnito, donde Chrome nunca deja instalar: ese único motivo no cuenta.
  const errors = installabilityErrors.map((e) => e.errorId).filter((id) => id !== "in-incognito");
  check(errors.length === 0, `Chrome no encuentra impedimentos para instalarlo${errors.length ? `: ${errors.join(", ")}` : ""}`);

  // Sin conexión: la cáscara abre desde la copia guardada
  await page.reload();
  await page.waitForSelector("h1");
  await page.evaluate(() => navigator.serviceWorker.ready);
  await context.setOffline(true);
  await page.reload();
  await page.waitForSelector("h1", { timeout: 10_000 });
  check((await page.locator("h1").innerText()) === "F1 Tracker", "sin conexión, la app abre");
  check((await page.locator(".foot").count()) === 1, "sin conexión, el pie y los estilos están");
  await context.setOffline(false);
} finally {
  await browser.close();
}

if (problems.length) {
  console.error(`\n${problems.length} comprobaciones fallaron`);
  process.exit(1);
}
console.log("\nTodo en orden");
