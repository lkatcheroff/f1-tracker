import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { RawMessage, RecordingEntry } from "@f1/core";
import { recordingsDir } from "./config";

/**
 * Graba a disco todo lo que entra en live, un mensaje crudo por línea (`.jsonl`).
 * El archivo se crea recién cuando llega un segundo `TimingData` (es decir, hay sesión en curso):
 * conectarse con la pista cerrada no deja grabaciones vacías.
 */
export class Recorder {
  file: string | null = null;
  private stream: WriteStream | null = null;
  private pending: string[] = [];
  private sessionPath = "";
  private timingSeen = 0;

  write(msg: RawMessage): void {
    if (msg.topic === "SessionInfo") {
      const p = (msg.data as any)?.Path;
      if (typeof p === "string" && p !== this.sessionPath) {
        this.close();
        this.sessionPath = p;
      }
    }
    const line = JSON.stringify(msg) + "\n";
    if (this.stream) return void this.stream.write(line);
    this.pending.push(line);
    if (msg.topic === "TimingData" && ++this.timingSeen >= 2) this.open();
  }

  private open(): void {
    mkdirSync(recordingsDir(), { recursive: true });
    const name = this.sessionPath.split("/").filter(Boolean).slice(1).join("__") || `sesion_${Date.now()}`;
    this.file = `${name}.jsonl`;
    this.stream = createWriteStream(path.join(recordingsDir(), this.file), { flags: "a" });
    for (const line of this.pending) this.stream.write(line);
    this.pending = [];
  }

  close(): void {
    this.stream?.end();
    this.stream = null;
    this.file = null;
    this.pending = [];
    this.timingSeen = 0;
  }
}

export async function listRecordings(): Promise<RecordingEntry[]> {
  let names: string[];
  try {
    names = (await readdir(recordingsDir())).filter((n) => n.endsWith(".jsonl"));
  } catch {
    return [];
  }
  const out = await Promise.all(
    names.map(async (file) => {
      const st = await stat(path.join(recordingsDir(), file));
      const label = file.replace(/\.jsonl$/, "").replace(/__/g, " · ").replace(/_/g, " ");
      return { file, label, sizeKb: Math.round(st.size / 1024), modified: st.mtime.toISOString() };
    }),
  );
  return out.sort((a, b) => b.modified.localeCompare(a.modified));
}

/** Lee una grabación propia y pasa los ts de epoch a ms desde el primer mensaje. */
export async function loadRecording(file: string): Promise<RawMessage[]> {
  if (!/^[\w.-]+\.jsonl$/.test(file)) throw new Error(`nombre de grabación inválido: ${file}`);
  const text = await readFile(path.join(recordingsDir(), file), "utf8");
  const out: RawMessage[] = [];
  for (const line of text.split("\n")) if (line) out.push(JSON.parse(line));
  const t0 = out[0]?.ts ?? 0;
  for (const m of out) m.ts -= t0;
  return out;
}
