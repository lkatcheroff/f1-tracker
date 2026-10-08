// Baja una sesión real del archivo estático de F1 a fixtures/ (la usan los tests del core).
// Uso: node scripts/fetch-fixture.mjs [path-de-sesión]
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BASE = "https://livetiming.formula1.com/static/";
const sessionPath = process.argv[2] ?? "2026/2026-09-26_Azerbaijan_Grand_Prix/2026-09-26_Race/";
const FILES = [
  "SessionInfo",
  "Heartbeat",
  "DriverList",
  "TimingData",
  "TimingAppData",
  "TimingStats",
  "LapCount",
  "SessionStatus",
  "TrackStatus",
  "RaceControlMessages",
  "WeatherData",
  "ExtrapolatedClock",
  "Position.z",
  "CarData.z",
];

const parts = sessionPath.split("/").filter(Boolean);
const name = `${parts[1]}_${parts[2].replace(/^\d{4}-\d{2}-\d{2}_/, "")}`;
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", name);
for (const f of FILES) {
  const res = await fetch(`${BASE}${sessionPath}${f}.jsonStream`);
  if (!res.ok) {
    // F1 responde 403 a servidores (por ejemplo, los de GitHub Actions): hay que correrlo desde una conexión hogareña.
    console.error(`${f}: HTTP ${res.status}. No se pudo bajar la fixture.`);
    process.exit(1);
  }
  await mkdir(dir, { recursive: true });
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(path.join(dir, `${f}.jsonStream`), buf);
  console.log(`${f}: ${(buf.length / 1024).toFixed(0)} KB`);
}
console.log(`listo: ${dir}`);
