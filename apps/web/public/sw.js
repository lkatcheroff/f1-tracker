/* Service worker de F1 Tracker: deja la app abrir sin conexión y guarda las sesiones que ya miraste.
 *
 * - Cáscara de la app (HTML, JS, CSS, íconos): de la red cuando hay; si no, la última copia.
 * - Calendario: de la red cuando hay; si no, la última copia.
 * - Sesiones y telemetría (data/s y data/t): sus nombres llevan la versión del formato, así que la copia
 *   guardada sirve siempre. Se conservan las últimas MAX_DATA para no llenar el teléfono.
 * - Todo lo que no es de este sitio (OpenF1, MultiViewer) pasa de largo.
 */
const VERSION = "v1";
const SHELL = `f1t-shell-${VERSION}`;
const CAL = `f1t-calendar-${VERSION}`;
const DATA = `f1t-data-${VERSION}`;
const MAX_DATA = 24;
const MAX_SHELL = 80;
const KEEP = [SHELL, CAL, DATA];

self.addEventListener("install", (event) => {
  self.skipWaiting();
  const precache = ["./", "manifest.webmanifest", "favicon.svg", "icons/icon-192.png", "icons/icon-512.png"];
  // Si algún archivo no está (por ejemplo en un despliegue a medias) la instalación igual sigue.
  event.waitUntil(caches.open(SHELL).then((cache) => Promise.allSettled(precache.map((url) => cache.add(url)))));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) if (!KEEP.includes(name)) await caches.delete(name);
      await self.clients.claim();
    })(),
  );
});

/** Borra las entradas más viejas hasta dejar `max`. Las claves salen en orden de inserción. */
async function trim(name, max) {
  const cache = await caches.open(name);
  const keys = await cache.keys();
  for (const key of keys.slice(0, Math.max(0, keys.length - max))) await cache.delete(key);
}

async function put(name, request, response) {
  if (!response || !response.ok || response.type === "opaque") return;
  const cache = await caches.open(name);
  await cache.put(request, response.clone());
}

async function networkFirst(request, name, fallbackUrl) {
  try {
    const response = await fetch(request);
    await put(name, request, response);
    return response;
  } catch (err) {
    const cached = (await caches.match(request)) || (fallbackUrl ? await caches.match(fallbackUrl) : undefined);
    if (cached) return cached;
    throw err;
  }
}

async function cacheFirst(request, name, max) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  await put(name, request, response);
  if (max) await trim(name, max);
  return response;
}

async function staleWhileRevalidate(request, name) {
  const cached = await caches.match(request);
  const refresh = fetch(request)
    .then(async (response) => {
      await put(name, request, response);
      return response;
    })
    .catch(() => undefined);
  return cached || (await refresh) || Response.error();
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  const path = url.pathname;
  if (/\/data\/(s|t)\//.test(path)) {
    event.respondWith(cacheFirst(request, DATA, MAX_DATA));
  } else if (/\/data\/calendar-\d+\.json$/.test(path)) {
    event.respondWith(networkFirst(request, CAL));
  } else if (request.mode === "navigate") {
    event.respondWith(networkFirst(request, SHELL, "./"));
  } else if (/\/assets\//.test(path)) {
    event.respondWith(cacheFirst(request, SHELL, MAX_SHELL));
  } else {
    event.respondWith(staleWhileRevalidate(request, SHELL));
  }
});
