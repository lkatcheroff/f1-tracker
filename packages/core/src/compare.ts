import { bestLap, completedLaps, type SessionTelemetry, type TelemetryLap } from "./telemetry";

/** Contra qué se compara una vuelta. */
export type RefKind =
  /** la mejor vuelta de la sesión hasta ahora */
  | "best"
  /** la mejor vuelta del mismo piloto */
  | "own"
  /** la vuelta anterior del mismo piloto */
  | "prev"
  /** clasificación: la mejor vuelta, en esta parte, del último que pasa */
  | "cut-in"
  /** clasificación: la mejor vuelta, en esta parte, del primero que queda afuera */
  | "cut-out"
  /** otro piloto: su mejor vuelta o la que se elija */
  | "driver";

export interface RefSpec {
  kind: RefKind;
  /** nº de auto, con `kind: "driver"` */
  driver?: string;
  /** "best" o nº de vuelta, con `kind: "driver"` */
  lap?: "best" | number;
}

/** Un piloto en el orden de la carrera o la clasificación. */
export interface OrderRow {
  num: string;
  tla: string;
  team: string;
  knockedOut: boolean;
  retired: boolean;
}

export interface CompareContext {
  tel: SessionTelemetry;
  /** instante de la sesión que se está viendo, ms de stream */
  now: number;
  /** con spoilers apagados se pueden ver también vueltas que todavía no ocurrieron */
  spoilerFree: boolean;
  /** parte de la clasificación en curso */
  part: number | null;
  /** cuántos pasan de ronda */
  through: number | null;
  /** pilotos por posición */
  order: OrderRow[];
}

/** Las vueltas que se pueden consultar: las ya cerradas, o todas si no hay que cuidar spoilers. */
export function lapPool(ctx: Pick<CompareContext, "tel" | "now" | "spoilerFree">): TelemetryLap[] {
  return ctx.spoilerFree ? completedLaps(ctx.tel, ctx.now) : ctx.tel.laps;
}

/** Quién está justo adentro y quién justo afuera del corte de clasificación. */
export function cutDrivers(order: OrderRow[], through: number | null): { lastIn: OrderRow | null; firstOut: OrderRow | null } {
  if (!through) return { lastIn: null, firstOut: null };
  const active = order.filter((d) => !d.knockedOut && !d.retired);
  return { lastIn: active[through - 1] ?? null, firstOut: active[through] ?? null };
}

export interface ResolvedRef {
  lap: TelemetryLap | null;
  /** cómo se llama la referencia, para mostrar */
  label: string;
  /** por qué no hay referencia, si no la hay */
  missing?: string;
}

const fmt = (ms: number) => {
  const m = Math.floor(ms / 60000);
  const s = ((ms - m * 60000) / 1000).toFixed(3).padStart(6, "0");
  return `${m}:${s}`;
};

export const lapLabel = (l: TelemetryLap, tla: string) => `${tla} · V${l.n} · ${fmt(l.ms)}`;

/** Encuentra la vuelta de referencia para `a` según `spec`. */
export function resolveRef(ctx: CompareContext, a: TelemetryLap, spec: RefSpec): ResolvedRef {
  const pool = lapPool(ctx);
  const tla = (num: string) => ctx.order.find((d) => d.num === num)?.tla ?? num;
  const pick = (laps: TelemetryLap[], what: string, who: string): ResolvedRef => {
    const lap = bestLap(laps);
    return lap
      ? { lap, label: lapLabel(lap, tla(lap.d)) }
      : { lap: null, label: what, missing: `${who} todavía no marcó una vuelta lanzada` };
  };

  switch (spec.kind) {
    case "best":
      return pick(pool, "Mejor de la sesión", "Nadie");
    case "own":
      return pick(
        pool.filter((l) => l.d === a.d),
        "Su mejor vuelta",
        "El piloto",
      );
    case "prev": {
      const lap = pool.find((l) => l.d === a.d && l.n === a.n - 1);
      return lap
        ? { lap, label: lapLabel(lap, tla(lap.d)) }
        : { lap: null, label: "Vuelta anterior", missing: "No hay una vuelta anterior registrada" };
    }
    case "cut-in":
    case "cut-out": {
      const { lastIn, firstOut } = cutDrivers(ctx.order, ctx.through);
      const who = spec.kind === "cut-in" ? lastIn : firstOut;
      const what = spec.kind === "cut-in" ? "Último que pasa" : "Primero eliminado";
      if (!who || !ctx.part) return { lap: null, label: what, missing: "No hay corte en esta parte" };
      return pick(
        pool.filter((l) => l.d === who.num && l.part === ctx.part),
        what,
        who.tla,
      );
    }
    case "driver": {
      if (!spec.driver) return { lap: null, label: "Otro piloto", missing: "Elegí un piloto" };
      const theirs = pool.filter((l) => l.d === spec.driver);
      if (typeof spec.lap === "number") {
        const lap = theirs.find((l) => l.n === spec.lap);
        return lap
          ? { lap, label: lapLabel(lap, tla(lap.d)) }
          : { lap: null, label: tla(spec.driver), missing: `${tla(spec.driver)} no tiene la vuelta ${spec.lap}` };
      }
      return pick(theirs, tla(spec.driver), tla(spec.driver));
    }
  }
}

/** Atajos para armar la comparación con un rival directo. */
export function rivalOf(order: OrderRow[], num: string, who: "teammate" | "ahead" | "behind"): OrderRow | null {
  const i = order.findIndex((d) => d.num === num);
  if (i < 0) return null;
  if (who === "teammate") return order.find((d) => d.team === order[i].team && d.num !== num) ?? null;
  const live = order.filter((d) => !d.retired || d.num === num);
  const j = live.findIndex((d) => d.num === num);
  return who === "ahead" ? (live[j - 1] ?? null) : (live[j + 1] ?? null);
}
