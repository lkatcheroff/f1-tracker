import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import type { RadioTranscripts } from "@f1/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHelperServer, originAllowed, RadioQueue, validClipUrl } from "../radio-helper-lib";
import { mergeCache } from "../transcribe-lib";

const BASE = "https://livetiming.formula1.com/static/2026/2026-10-11_Singapore_Grand_Prix/2026-10-11_Race/TeamRadio";
const url = (id: string) => `${BASE}/${id}.mp3`;
const FILE = "2026__2026-10-11_Singapore_Grand_Prix__2026-10-11_Race.json";

describe("qué pide la página y qué se acepta", () => {
  it("solo los orígenes del sitio y del desarrollo local", () => {
    expect(originAllowed("https://lkatcheroff.github.io")).toBe(true);
    expect(originAllowed("http://localhost:5173")).toBe(true);
    for (const bad of ["https://ejemplo.test", "https://lkatcheroff.github.io.malo.test", "http://localhost:9999", "null", undefined]) {
      expect(originAllowed(bad), String(bad)).toBe(false);
    }
  });

  it("solo audios de radio del archivo de F1: nunca otra dirección", () => {
    expect(validClipUrl(url("ALB_23_1"))).toBe(true);
    for (const bad of [
      "https://ejemplo.test/static/2026/x/TeamRadio/a.mp3",
      "http://livetiming.formula1.com/static/2026/x/TeamRadio/a.mp3",
      "https://livetiming.formula1.com/static/2026/x/Otra/a.mp3",
      "https://livetiming.formula1.com/static/../secreto/TeamRadio/a.mp3",
      "file:///etc/passwd",
      "https://livetiming.formula1.com.malo.test/static/2026/x/TeamRadio/a.mp3",
      "",
      42,
      null,
    ]) {
      expect(validClipUrl(bad), String(bad)).toBe(false);
    }
  });
});

function makeQueue(over: { published?: RadioTranscripts; work?: (urls: string[], drivers: string[]) => Promise<RadioTranscripts> } = {}) {
  const cache: Record<string, RadioTranscripts> = {};
  const calls: { urls: string[]; drivers: string[] }[] = [];
  const queue = new RadioQueue({
    readPublished: async () => over.published ?? {},
    readCache: async (f) => cache[f] ?? {},
    writeCache: async (f, t) => {
      cache[f] = t;
    },
    work: async (urls, drivers) => {
      calls.push({ urls, drivers });
      if (over.work) return over.work(urls, drivers);
      return Object.fromEntries(urls.map((u) => [u.split("/").pop() as string, { text: `texto de ${u.split("/").pop()}`, lang: "en" }]));
    },
    log: () => {},
  });
  return { queue, cache, calls };
}
const idle = async (q: RadioQueue) => {
  for (let i = 0; i < 200 && q.pending; i++) await new Promise((r) => setTimeout(r, 5));
};

describe("cola de transcripción", () => {
  it("transcribe lo que falta y lo guarda en la caché de la sesión", async () => {
    const { queue, cache, calls } = makeQueue();
    expect(await queue.enqueue([url("A_1"), url("B_2")], ["Max VERSTAPPEN"])).toBe(2);
    await idle(queue);
    expect(calls).toHaveLength(1);
    expect(calls[0].drivers).toEqual(["Max VERSTAPPEN"]);
    expect(cache[FILE]["A_1.mp3"].text).toBe("texto de A_1.mp3");
    expect(Object.keys(await queue.texts(FILE)).sort()).toEqual(["A_1.mp3", "B_2.mp3"]);
  });

  it("no repite lo que ya tiene texto, ni publicado ni en caché", async () => {
    const { queue, calls } = makeQueue({ published: { "A_1.mp3": { text: "ya publicado", lang: "en" } } });
    expect(await queue.enqueue([url("A_1")])).toBe(0);
    expect(await queue.enqueue([url("B_2")])).toBe(1);
    await idle(queue);
    expect(await queue.enqueue([url("B_2")])).toBe(0);
    expect(calls.flatMap((c) => c.urls)).toEqual([url("B_2")]);
  });

  it("lo publicado manda sobre lo transcripto acá", async () => {
    const { queue, cache } = makeQueue({ published: { "A_1.mp3": { text: "publicado", lang: "en" } } });
    cache[FILE] = { "A_1.mp3": { text: "local", lang: "en" } };
    expect((await queue.texts(FILE))["A_1.mp3"].text).toBe("publicado");
  });

  it("no encola dos veces lo que está esperando", async () => {
    const { queue } = makeQueue();
    expect(await queue.enqueue([url("A_1"), url("A_1")])).toBe(1);
  });

  it("descarta direcciones inválidas sin romper el resto", async () => {
    const { queue, calls } = makeQueue();
    expect(await queue.enqueue(["https://ejemplo.test/x.mp3", url("A_1"), 5, null])).toBe(1);
    await idle(queue);
    expect(calls[0].urls).toEqual([url("A_1")]);
  });

  it("de a tandas de 10", async () => {
    const { queue, calls } = makeQueue();
    await queue.enqueue(Array.from({ length: 25 }, (_, i) => url(`X_${i}`)));
    await idle(queue);
    expect(calls.map((c) => c.urls.length)).toEqual([10, 10, 5]);
  });

  it("si una tanda falla, se descarta, la cola sigue y se puede volver a pedir", async () => {
    let n = 0;
    const { queue, calls } = makeQueue({
      work: async (urls) => {
        if (++n === 1) throw new Error("sin conexión a F1");
        return Object.fromEntries(urls.map((u) => [u.split("/").pop() as string, { text: "ok", lang: "en" }]));
      },
    });
    await queue.enqueue([url("A_1")]);
    await idle(queue);
    expect(queue.pending).toBe(0);
    expect(await queue.enqueue([url("A_1")])).toBe(1);
    await idle(queue);
    expect(calls).toHaveLength(2);
    expect((await queue.texts(FILE))["A_1.mp3"].text).toBe("ok");
  });

  it("un mensaje que Whisper no devolvió no queda marcado como hecho", async () => {
    const { queue } = makeQueue({ work: async () => ({}) });
    await queue.enqueue([url("A_1")]);
    await idle(queue);
    expect(await queue.enqueue([url("A_1")])).toBe(1);
  });
});

describe("servidor HTTP", () => {
  let server: ReturnType<typeof createHelperServer>;
  let base: string;
  let queueRef: ReturnType<typeof makeQueue>;
  beforeEach(async () => {
    queueRef = makeQueue({ published: { "P_1.mp3": { text: "publicado", lang: "en" } } });
    server = createHelperServer(queueRef.queue, { model: "small" });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(() => new Promise<void>((r) => server.close(() => r())));

  const SITE = "https://lkatcheroff.github.io";
  const post = (body: unknown, origin: string | null = SITE) =>
    fetch(`${base}/transcribe`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(origin ? { origin } : {}) },
      body: JSON.stringify(body),
    });

  it("responde /health con el origen del sitio permitido", async () => {
    const res = await fetch(`${base}/health`, { headers: { origin: SITE } });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe(SITE);
    expect(await res.json()).toEqual({ ok: true, pending: 0, model: "small" });
  });

  it("la verificación previa de Chrome (red privada) se acepta", async () => {
    const res = await fetch(`${base}/transcribe`, {
      method: "OPTIONS",
      headers: { origin: SITE, "access-control-request-method": "POST", "access-control-request-private-network": "true" },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-private-network")).toBe("true");
    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
  });

  it("un sitio ajeno recibe 403 y no puede encolar nada", async () => {
    const res = await post({ clips: [url("A_1")] }, "https://ejemplo.test");
    expect(res.status).toBe(403);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect((await fetch(`${base}/health`, { headers: { origin: "https://ejemplo.test" } })).status).toBe(403);
    expect(queueRef.queue.pending).toBe(0);
    expect(queueRef.calls).toHaveLength(0);
  });

  it("encola los audios válidos y devuelve cuántos entraron", async () => {
    const res = await post({ clips: [url("A_1"), "https://ejemplo.test/a.mp3"], drivers: ["Lando NORRIS"] });
    expect(await res.json()).toMatchObject({ accepted: 1 });
    await idle(queueRef.queue);
    expect(queueRef.calls[0]).toEqual({ urls: [url("A_1")], drivers: ["Lando NORRIS"] });
  });

  it("rechaza pedidos mal armados", async () => {
    expect((await post({ clips: "no es una lista" })).status).toBe(400);
    expect((await post({ clips: Array.from({ length: 201 }, (_, i) => url(`X_${i}`)) })).status).toBe(400);
    expect((await fetch(`${base}/transcribe`, { method: "POST", body: "{no es json", headers: { origin: SITE } })).status).toBe(400);
  });

  it("/texts devuelve lo publicado más lo transcripto, y no acepta nombres que sean rutas", async () => {
    await post({ clips: [url("A_1")] });
    await idle(queueRef.queue);
    const ok = await (await fetch(`${base}/texts?file=${FILE}`, { headers: { origin: SITE } })).json();
    expect(Object.keys(ok.texts).sort()).toEqual(["A_1.mp3", "P_1.mp3"]);
    for (const bad of ["", "a.txt", "../package.json", "a/b.json"]) {
      expect((await fetch(`${base}/texts?file=${encodeURIComponent(bad)}`)).status, bad).toBe(400);
    }
  });

  it("sin origen (curl, un script local) se atiende igual, sin encabezados de CORS", async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("rutas desconocidas dan 404", async () => {
    expect((await fetch(`${base}/otra`)).status).toBe(404);
  });
});

describe("mezcla de la caché con lo publicado", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "mix-"));
    await mkdir(path.join(dir, "cache"));
    await mkdir(path.join(dir, "out"));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it("suma lo nuevo sin pisar lo ya publicado", async () => {
    await writeFile(
      path.join(dir, "cache", FILE),
      JSON.stringify({ "A.mp3": { text: "local", lang: "en" }, "B.mp3": { text: "nuevo", lang: "en" } }),
    );
    await writeFile(path.join(dir, "out", FILE), JSON.stringify({ "A.mp3": { text: "publicado", lang: "en" } }));
    expect(await mergeCache(path.join(dir, "cache"), path.join(dir, "out"))).toBe(1);
    const out = JSON.parse(await readFile(path.join(dir, "out", FILE), "utf8"));
    expect(out["A.mp3"].text).toBe("publicado");
    expect(out["B.mp3"].text).toBe("nuevo");
    expect(await mergeCache(path.join(dir, "cache"), path.join(dir, "out"))).toBe(0);
  });

  it("sin carpeta de caché no hace nada", async () => {
    expect(await mergeCache(path.join(dir, "no-existe"), path.join(dir, "out"))).toBe(0);
  });
});
