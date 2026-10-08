// Genera `packages/core/test/schema.json`: la FORMA de los mensajes del feed (claves y tipos), sin ningún valor.
//
// Lo usan los tests para comprobar que los escenarios sintéticos (`test/builders.ts`) emiten mensajes con la forma
// real, sin commitear datos del feed. Los números (nº de auto, índices) se normalizan a `*`.
//
// Uso: npm run fixture:schema [-- <carpeta-con-.jsonStream> ...]   (por defecto, la fixture y las sesiones cacheadas)
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseJsonStream, prepareMessages, REPLAY_TOPICS } from "@f1/core";

const root = path.resolve(import.meta.dirname, "..");

function defaultDirs(): string[] {
  const dirs = readdirSync(path.join(root, "fixtures"), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => path.join(root, "fixtures", d.name));
  const cache = path.join(root, "data/cache/static");
  const walk = (dir: string): string[] => {
    if (!existsSync(dir)) return [];
    const here = readdirSync(dir, { withFileTypes: true });
    if (here.some((e) => e.name === "TimingData.jsonStream")) return [dir];
    return here.filter((e) => e.isDirectory()).flatMap((e) => walk(path.join(dir, e.name)));
  };
  return [...dirs, ...walk(cache)];
}

const dirs = process.argv.slice(2).length ? process.argv.slice(2).map((d) => path.resolve(d)) : defaultDirs();
const topics: Record<string, Map<string, Set<string>>> = {};

const typeOf = (v: unknown) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);

function walk(topic: string, prefix: string, value: unknown) {
  let paths = topics[topic];
  if (!paths) {
    paths = new Map();
    topics[topic] = paths;
  }
  const add = (p: string, t: string) => {
    let s = paths.get(p);
    if (!s) {
      s = new Set();
      paths.set(p, s);
    }
    s.add(t);
  };
  add(prefix, typeOf(value));
  if (Array.isArray(value)) for (const v of value) walk(topic, `${prefix}.*`, v);
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) walk(topic, `${prefix}.${/^\d+$/.test(k) ? "*" : k}`, v);
  }
}

for (const dir of dirs) {
  const raw = [];
  for (const t of REPLAY_TOPICS) {
    const file = path.join(dir, `${t}.jsonStream`);
    if (existsSync(file)) raw.push(...parseJsonStream(t, readFileSync(file, "utf8")));
  }
  for (const m of prepareMessages(raw)) walk(m.topic, "$", m.data);
  console.log(`leído: ${path.relative(root, dir)}`);
}

const out = {
  note: "Forma de los mensajes del feed (rutas y tipos). Sin valores. Se genera con `npm run fixture:schema`.",
  topics: Object.fromEntries(
    Object.entries(topics)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([topic, paths]) => [
        topic,
        Object.fromEntries([...paths].sort(([a], [b]) => a.localeCompare(b)).map(([p, t]) => [p, [...t].sort()])),
      ]),
  ),
};
const file = path.join(root, "packages/core/test/schema.json");
writeFileSync(file, `${JSON.stringify(out, null, 1)}\n`);
console.log(
  `escrito ${path.relative(root, file)}: ${Object.keys(out.topics).length} topics, ${Object.values(out.topics).reduce((n, t) => n + Object.keys(t).length, 0)} rutas`,
);
