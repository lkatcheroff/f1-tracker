import type { ClientCommand, ServerMessage, SessionsResponse } from "@f1/core";
import websocket from "@fastify/websocket";
import Fastify from "fastify";
import { listMeetings } from "./archive";
import { loadSession, loadTelemetryFile } from "./loader";
import { listRecordings } from "./recorder";
import { type ClientSession, liveHub, ReplaySession } from "./sessions";

/** Lo que el server toma de afuera (disco, red, feed en vivo). Se reemplaza en los tests. */
export interface AppDeps {
  loadSession: typeof loadSession;
  loadTelemetryFile: typeof loadTelemetryFile;
  listMeetings: typeof listMeetings;
  listRecordings: typeof listRecordings;
  liveHub: Pick<typeof liveHub, "join">;
}
const real: AppDeps = { loadSession, loadTelemetryFile, listMeetings, listRecordings, liveHub };

export async function buildApp(over: Partial<AppDeps> = {}) {
  const deps = { ...real, ...over };
  const app = Fastify({ logger: { level: "warn" } });
  await app.register(websocket);

  app.get<{ Querystring: { year?: string } }>("/api/sessions", async (req): Promise<SessionsResponse> => {
    const year = Number(req.query.year) || new Date().getUTCFullYear();
    const [meetings, recordings] = await Promise.all([deps.listMeetings(year), deps.listRecordings()]);
    return { year, meetings, recordings };
  });

  app.get<{ Querystring: { source?: string } }>("/api/telemetry", async (req, reply) => {
    const source = req.query.source;
    if (!source) return reply.code(400).send({ error: "falta source" });
    try {
      const bytes = await deps.loadTelemetryFile(source);
      if (!bytes) return reply.code(404).send({ error: "esta sesión no tiene telemetría" });
      return reply.header("content-type", "application/octet-stream").send(Buffer.from(bytes));
    } catch (err) {
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get("/ws", { websocket: true }, (socket) => {
    let session: ClientSession | null = null;
    let opening = 0;
    const send = (m: ServerMessage) => socket.readyState === socket.OPEN && socket.send(JSON.stringify(m));

    socket.on("message", async (buf) => {
      let cmd: ClientCommand;
      try {
        cmd = JSON.parse(buf.toString());
      } catch {
        return;
      }
      if (cmd.type !== "open") return session?.handle(cmd);

      session?.close();
      session = null;
      const mine = ++opening;
      if (cmd.mode === "live") {
        session = deps.liveHub.join(send);
        return;
      }
      try {
        const loaded = await deps.loadSession(cmd.source, (step) => mine === opening && send({ type: "loading", step }));
        // Si mientras cargaba llegó otro `open` o se cerró la conexión, esta carga ya no corre.
        if (mine !== opening || socket.readyState !== socket.OPEN) return;
        session = new ReplaySession(loaded, send, cmd.at);
      } catch (err) {
        if (mine === opening) send({ type: "error", message: err instanceof Error ? err.message : String(err) });
      }
    });
    socket.on("close", () => {
      opening++;
      session?.close();
    });
  });

  return app;
}
