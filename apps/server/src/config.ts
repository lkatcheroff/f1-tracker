import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

export const config = {
  port: Number(process.env.F1_SERVER_PORT ?? 8787),
  dataDir: process.env.F1_DATA_DIR ?? path.join(root, "data"),
  staticBase: "https://livetiming.formula1.com/static/",
  liveBase: "livetiming.formula1.com/signalrcore",
};

export const cacheDir = (...p: string[]) => path.join(config.dataDir, "cache", ...p);
export const recordingsDir = () => path.join(config.dataDir, "recordings");
