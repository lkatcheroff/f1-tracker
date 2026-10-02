import websocket from "@fastify/websocket";
import type { ClientCommand, ServerMessage, SessionsResponse } from "@f1/core";
import Fastify from "fastify";
import { listMeetings } from "./archive";
import { config } from "./config";
import { loadSession } from "./loader";
import { listRecordings } from "./recorder";
import { liveHub, ReplaySession, type ClientSession } from "./sessions";

const app = Fastify({ logger: { level: "warn" } });
await app.register(websocket);

app.get<{ Querystring: { year?: string } }>("/api/sessions", async (req): Promise<SessionsResponse> => {
  const year = Number(req.query.year) || new Date().getUTCFullYear();
  const [meetings, recordings] = await Promise.all([listMeetings(year), listRecordings()]);
  return { year, meetings, recordings };
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
      session = liveHub.join(send);
      return;
    }
    try {
      const loaded = await loadSession(cmd.source, (step) => mine === opening && send({ type: "loading", step }));
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

await app.listen({ port: config.port, host: "127.0.0.1" });
console.log(`f1-tracker server en http://127.0.0.1:${config.port}`);
