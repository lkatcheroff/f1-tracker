// Arma los datos del sitio estático. Lo corre la GitHub Action cada pocos minutos; solo baja lo que falta.
//
// Fuente: el archivo oficial de F1 si responde (desde una conexión hogareña) y si no, OpenF1.
// F1 le contesta 403 a los servidores de GitHub, así que la Action siempre termina usando OpenF1.
// Uso: tsx scripts/mirror.ts <dir-de-salida> [--max 40]
import path from "node:path";
import { listOpenF1Meetings, loadOpenF1Session } from "@f1/openf1";
import { fetchText, mirror } from "./mirror-lib";

const maxArg = process.argv.indexOf("--max");

await mirror(
  {
    outDir: path.resolve(process.argv[2] ?? "site-data"),
    maxSessions: Number(maxArg > -1 ? process.argv[maxArg + 1] : (process.env.MIRROR_MAX_SESSIONS ?? 40)),
    // OpenF1 limita a 30 pedidos por minuto y una sesión lleva ~55 con telemetría: se procesan pocas por corrida y el resto, en las siguientes.
    maxNewOpenF1: Number(process.env.MIRROR_MAX_NEW_PER_RUN ?? 5),
    forceOpenF1: process.env.MIRROR_SOURCE === "openf1",
    githubOutput: process.env.GITHUB_OUTPUT,
  },
  {
    fetchText: (url) => fetchText(url),
    loadOpenF1: (startUtc) => loadOpenF1Session(startUtc, () => {}, { withCar: true }),
    listOpenF1: listOpenF1Meetings,
    now: Date.now,
    log: (line) => console.log(line),
  },
);
