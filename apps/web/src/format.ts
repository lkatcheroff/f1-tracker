const pad = (n: number) => String(n).padStart(2, "0");

/** ms → "H:MM:SS" (o "MM:SS" si no llega a la hora) */
export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const rest = `${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
  return h ? `${h}:${rest}` : rest;
}

export function fmtLocalDateTime(iso: string): string {
  return new Date(iso).toLocaleString("es-AR", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

export const SESSION_STATUS: Record<string, string> = {
  Inactive: "Sin iniciar",
  Started: "En curso",
  Aborted: "Interrumpida",
  Finished: "Finalizada",
  Finalised: "Finalizada",
  Ends: "Terminada",
};

/** Código de `TrackStatus` → etiqueta y tono */
export const TRACK_STATUS: Record<string, { label: string; tone: "green" | "yellow" | "red" | "orange" }> = {
  "1": { label: "Pista libre", tone: "green" },
  "2": { label: "Bandera amarilla", tone: "yellow" },
  "4": { label: "Safety Car", tone: "orange" },
  "5": { label: "Bandera roja", tone: "red" },
  "6": { label: "Virtual Safety Car", tone: "orange" },
  "7": { label: "Fin de VSC", tone: "orange" },
};

export const store = {
  get<T>(key: string, fallback: T): T {
    try {
      const v = localStorage.getItem(key);
      return v === null ? fallback : (JSON.parse(v) as T);
    } catch {
      return fallback;
    }
  },
  set(key: string, value: unknown): void {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // sin localStorage (modo privado): la app funciona igual, solo no recuerda
    }
  },
};
