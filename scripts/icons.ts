// Genera los íconos de la app instalable (PNG) a partir del auto del favicon.
// Uso: npm run icons   (necesita Chrome; los PNG quedan versionados en apps/web/public/icons)
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { launch } from "./browser";

const out = path.resolve("apps/web/public/icons");
await mkdir(out, { recursive: true });
const svg = await readFile("apps/web/public/favicon.svg", "utf8");
// Solo el dibujo del auto: se saca la etiqueta <svg> y se coloca dentro de un lienzo propio.
// Las ruedas del favicon (#1a1a1a) se pierden contra el fondo oscuro del ícono: se aclaran.
const car = svg
  .replace(/<svg[^>]*>/, "")
  .replace("</svg>", "")
  .replaceAll("#1a1a1a", "#5a5a56");

/** `scale`: qué parte del lienzo ocupa el auto. En los maskables, 0.56 cabe en la zona segura (círculo del 80 %). */
const icon = (size: number, scale: number, rounded: boolean) => {
  const s = (size * scale) / 64;
  const offset = (size - 64 * s) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" rx="${rounded ? size * 0.22 : 0}" fill="#101010"/>
  <g transform="translate(${offset} ${offset}) scale(${s})">${car}</g>
</svg>`;
};

const targets = [
  { file: "icon-192.png", size: 192, scale: 0.78, rounded: true },
  { file: "icon-512.png", size: 512, scale: 0.78, rounded: true },
  { file: "icon-maskable-512.png", size: 512, scale: 0.56, rounded: false },
  { file: "apple-touch-icon.png", size: 180, scale: 0.7, rounded: false },
];

const browser = await launch();
try {
  const page = await browser.newPage();
  for (const t of targets) {
    await page.setViewportSize({ width: t.size, height: t.size });
    await page.setContent(`<body style="margin:0;background:transparent">${icon(t.size, t.scale, t.rounded)}</body>`);
    await writeFile(path.join(out, t.file), await page.screenshot({ omitBackground: true, type: "png" }));
    console.log(`apps/web/public/icons/${t.file}`);
  }
} finally {
  await browser.close();
}
