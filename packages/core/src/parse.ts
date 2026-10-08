/**
 * Gap del feed → segundos. Formatos vistos en datos 2026: "+12.345", "+1:02.345", "LAP 14" (líder),
 * "1L" / "1 L" / "12L" (vueltas perdidas), "" (sin dato).
 */
export function parseGap(s: string | undefined | null): number | null {
  if (!s) return null;
  if (s.startsWith("LAP")) return 0;
  const m = /^\+?(?:(\d+):)?(\d+\.\d+)$/.exec(s.trim());
  if (!m) return null;
  return (m[1] ? +m[1] * 60 : 0) + +m[2];
}

/** "1:47.607" o "47.607" → segundos */
export function parseLapTime(s: string | undefined | null): number | null {
  if (!s) return null;
  const m = /^(?:(\d+):)?(\d+\.\d+)$/.exec(s.trim());
  if (!m) return null;
  return (m[1] ? +m[1] * 60 : 0) + +m[2];
}

/** "01:53:49" → ms */
export function parseClock(s: string | undefined | null): number | null {
  if (!s) return null;
  const m = /^(\d+):(\d{2}):(\d{2})$/.exec(s);
  if (!m) return null;
  return ((+m[1] * 60 + +m[2]) * 60 + +m[3]) * 1000;
}

const num = (s: unknown): number | null => {
  const n = typeof s === "number" ? s : parseFloat(String(s ?? ""));
  return Number.isFinite(n) ? n : null;
};

export { num as toNumber };
