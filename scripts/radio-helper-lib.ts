import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { type RadioTranscripts, radioId, radioTranscriptFile } from "@f1/core";

/**
 * Servicio local de transcripción: la página (publicada o de desarrollo) le pide los mensajes de radio que le faltan y
 * él los baja desde esta compu, los pasa por Whisper y se los devuelve. Solo escucha en 127.0.0.1.
 */

/** Páginas que pueden hablarle. Cualquier otro origen recibe 403: así un sitio ajeno no puede usar tu compu. */
export const ALLOWED_ORIGINS = ["https://lkatcheroff.github.io", "http://localhost:5173", "http://127.0.0.1:5173", "http://localhost:4173"];

export const originAllowed = (origin: string | undefined): boolean => origin !== undefined && ALLOWED_ORIGINS.includes(origin);

/** Solo audios de radio del archivo de F1: el servicio nunca baja otra cosa, sin importar lo que pida la página. */
export function validClipUrl(url: unknown): url is string {
  return (
    typeof url === "string" &&
    url.startsWith("https://livetiming.formula1.com/static/") &&
    !url.includes("..") &&
    radioId(url) !== null &&
    radioTranscriptFile(url) !== null
  );
}

export interface QueueDeps {
  /** lo ya publicado en el repositorio */
  readPublished(file: string): Promise<RadioTranscripts>;
  /** lo que transcribió este servicio */
  readCache(file: string): Promise<RadioTranscripts>;
  writeCache(file: string, t: RadioTranscripts): Promise<void>;
  /** baja y transcribe estas direcciones; devuelve el texto por id */
  work(urls: string[], drivers: string[]): Promise<RadioTranscripts>;
  log(line: string): void;
}

const BATCH = 10;

/** Cola de mensajes por transcribir: sin repetir, de a tandas, sin pisar lo que ya existe. */
export class RadioQueue {
  private waiting = new Map<string, string[]>();
  private inFlight = new Set<string>();
  private running = false;

  constructor(private readonly deps: QueueDeps) {}

  get pending(): number {
    return this.waiting.size + this.inFlight.size;
  }

  /** Suma los mensajes que todavía no tienen texto. Devuelve cuántos entraron a la cola. */
  async enqueue(urls: unknown[], drivers: string[] = []): Promise<number> {
    let added = 0;
    const known = new Map<string, RadioTranscripts>();
    for (const url of urls) {
      if (!validClipUrl(url) || this.waiting.has(url) || this.inFlight.has(url)) continue;
      const file = radioTranscriptFile(url) as string;
      if (!known.has(file)) known.set(file, await this.texts(file));
      if (known.get(file)?.[radioId(url) as string]) continue;
      this.waiting.set(url, drivers);
      added++;
    }
    if (added) void this.drain();
    return added;
  }

  /** Lo conocido de una sesión: lo publicado manda sobre lo que transcribió este servicio. */
  async texts(file: string): Promise<RadioTranscripts> {
    return { ...(await this.deps.readCache(file)), ...(await this.deps.readPublished(file)) };
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.waiting.size) {
        const batch = [...this.waiting.entries()].slice(0, BATCH);
        for (const [url] of batch) {
          this.waiting.delete(url);
          this.inFlight.add(url);
        }
        try {
          const urls = batch.map(([u]) => u);
          const drivers = [...new Set(batch.flatMap(([, d]) => d))];
          const result = await this.deps.work(urls, drivers);
          const byFile = new Map<string, RadioTranscripts>();
          for (const url of urls) {
            const id = radioId(url) as string;
            if (!result[id]) continue;
            const file = radioTranscriptFile(url) as string;
            byFile.set(file, { ...byFile.get(file), [id]: result[id] });
          }
          for (const [file, add] of byFile) await this.deps.writeCache(file, { ...(await this.deps.readCache(file)), ...add });
          this.deps.log(`${Object.keys(result).length} mensajes transcriptos`);
        } catch (err) {
          // Un fallo descarta la tanda; la página vuelve a pedirla la próxima vez que se abra la sesión.
          this.deps.log(`falló una tanda: ${err instanceof Error ? err.message : err}`);
        } finally {
          this.inFlight.clear();
        }
      }
    } finally {
      this.running = false;
    }
  }
}

const readBody = (req: IncomingMessage, limit = 64 * 1024): Promise<string> =>
  new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > limit) {
        reject(new Error("pedido demasiado grande"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });

export function createHelperServer(queue: RadioQueue, info: { model: string }): Server {
  const send = (res: ServerResponse, status: number, body: unknown) => {
    res.statusCode = status;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify(body));
  };

  return createServer(async (req, res) => {
    const origin = req.headers.origin;
    // Un navegador siempre manda su origen; sin origen (curl, un script local) se deja pasar.
    if (origin !== undefined && !originAllowed(origin)) return send(res, 403, { error: "origen no permitido" });
    if (origin) {
      res.setHeader("access-control-allow-origin", origin);
      res.setHeader("vary", "Origin");
      // Chrome pide este permiso para que una página pública hable con un servicio de la propia compu.
      res.setHeader("access-control-allow-private-network", "true");
      res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
      res.setHeader("access-control-allow-headers", "content-type");
      res.setHeader("access-control-max-age", "600");
    }
    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      return res.end();
    }

    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    try {
      if (req.method === "GET" && url.pathname === "/health")
        return send(res, 200, { ok: true, pending: queue.pending, model: info.model });
      if (req.method === "GET" && url.pathname === "/texts") {
        const file = url.searchParams.get("file") ?? "";
        if (!/^[\w.-]+\.json$/.test(file) || file.includes("..")) return send(res, 400, { error: "nombre inválido" });
        return send(res, 200, { pending: queue.pending, texts: await queue.texts(file) });
      }
      if (req.method === "POST" && url.pathname === "/transcribe") {
        const body = JSON.parse((await readBody(req)) || "{}") as { clips?: unknown; drivers?: unknown };
        if (!Array.isArray(body.clips) || body.clips.length > 200) return send(res, 400, { error: "clips inválidos" });
        const drivers = Array.isArray(body.drivers) ? body.drivers.filter((d): d is string => typeof d === "string").slice(0, 40) : [];
        const accepted = await queue.enqueue(body.clips, drivers);
        return send(res, 200, { accepted, pending: queue.pending });
      }
      return send(res, 404, { error: "no existe" });
    } catch (err) {
      return send(res, 400, { error: err instanceof Error ? err.message : "pedido inválido" });
    }
  });
}
