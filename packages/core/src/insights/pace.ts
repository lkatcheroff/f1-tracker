import type { Params } from "./params";
import type { LapRow, Stint } from "./types";

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export interface PaceStint {
  driver: string;
  stint: number;
  compound: string;
  /** vueltas limpias usadas */
  n: number;
  /** pendiente de tiempo contra edad del neumático, s por vuelta (positivo = cada vuelta es más lenta) */
  slope: number;
  r2: number;
  /** cada vuelta limpia: edad del neumático y tiempo relativo a la primera limpia del stint, en segundos */
  points: { age: number; rel: number }[];
}

/**
 * Tendencia de ritmo de un stint. Usa solo vueltas limpias: sin entrada ni salida de boxes, sin neutralización ni
 * amarilla, no la vuelta 1, y descarta las que superan la mediana del stint más `CLEAN_LAP_MAD_K` veces la MAD
 * (tráfico, errores). Hacen falta `MIN_STINT_LAPS`. Es regresión lineal por mínimos cuadrados.
 *
 * Ojo con la lectura: la pendiente incluye el efecto de la carga de combustible (cada vuelta el auto pesa menos y
 * es más rápido), que no se corrige. Por eso se llama tendencia de ritmo y no degradación.
 */
export function paceOfStint(stint: Stint, P: Params): PaceStint | null {
  const laps = stint.rows.filter(
    (r) => !r.inLap && !r.outLap && !r.neutralized && !r.yellow && r.lap > 1 && r.lapTimeMs !== null && r.tyre,
  );
  if (laps.length < P.MIN_STINT_LAPS) return null;
  const times = laps.map((r) => (r.lapTimeMs as number) / 1000);
  const med = median(times);
  const mad = Math.max(median(times.map((t) => Math.abs(t - med))), 0.2);
  const kept = laps.filter((_, i) => times[i] <= med + P.CLEAN_LAP_MAD_K * mad);
  if (kept.length < P.MIN_STINT_LAPS) return null;

  const xs = kept.map((r) => r.tyre?.age as number);
  const ys = kept.map((r) => (r.lapTimeMs as number) / 1000);
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  const sxx = xs.reduce((a, x) => a + (x - mx) ** 2, 0);
  if (sxx === 0) return null;
  const sxy = xs.reduce((a, x, i) => a + (x - mx) * (ys[i] - my), 0);
  const slope = sxy / sxx;
  const intercept = my - slope * mx;
  const ssTot = ys.reduce((a, y) => a + (y - my) ** 2, 0);
  const ssRes = ys.reduce((a, y, i) => a + (y - (intercept + slope * xs[i])) ** 2, 0);
  return {
    driver: stint.driver,
    stint: stint.index,
    compound: stint.compound,
    n,
    slope,
    r2: ssTot === 0 ? 1 : 1 - ssRes / ssTot,
    points: xs.map((age, i) => ({ age, rel: ys[i] - ys[0] })),
  };
}

export function paceStints(stints: Stint[], P: Params): PaceStint[] {
  return stints.map((s) => paceOfStint(s, P)).filter((p): p is PaceStint => p !== null);
}

export interface Projection {
  /** el que viene atrás y más rápido */
  chaser: string;
  ahead: string;
  /** cuánto más rápido es el de atrás, s por vuelta */
  closing: number;
  /** intervalo actual, s */
  gapSec: number;
  /** en cuántas vueltas lo alcanza, si sigue así */
  laps: number;
}

/**
 * "Lo alcanza en N vueltas". Para cada auto con otro delante: ritmo de cada uno = media de sus últimas `PACE_WINDOW`
 * vueltas, siempre que todas sean limpias (sin boxes, neutralización ni amarilla en la ventana). Si el de atrás gana
 * al menos `MIN_CLOSING` s por vuelta, el cierre proyectado es (intervalo − `BATTLE_GAP_SEC`) / cierre. Solo se
 * informa si cabe en las vueltas que quedan. Proyección lineal: no considera tráfico, paradas ni neutralizaciones.
 * `rows` ya tiene que venir filtrado hasta el instante actual.
 */
export function projections(rows: LapRow[], P: Params, lapsLeft: number | null): Projection[] {
  const by = new Map<string, LapRow[]>();
  for (const r of rows) {
    let list = by.get(r.driver);
    if (!list) {
      list = [];
      by.set(r.driver, list);
    }
    list.push(r);
  }
  const latest = [...by.values()].map((l) => l.sort((a, b) => a.lap - b.lap)).filter((l) => l.length);
  const topLap = Math.max(0, ...latest.map((l) => l[l.length - 1].lap));
  // Solo autos que siguen vueltas al día con el que más lleva: los demás se retiraron o van lejos.
  const active = latest.filter((l) => l[l.length - 1].lap >= topLap - 1 && l[l.length - 1].position !== null);
  const byPos = new Map(active.map((l) => [l[l.length - 1].position as number, l]));

  const paceOf = (l: LapRow[]): number | null => {
    const w = l.slice(-P.PACE_WINDOW);
    if (w.length < P.PACE_WINDOW || w.some((r) => r.inLap || r.outLap || r.neutralized || r.yellow || r.lapTimeMs === null || r.lap <= 1))
      return null;
    return w.reduce((a, r) => a + (r.lapTimeMs as number), 0) / w.length / 1000;
  };

  const out: Projection[] = [];
  for (const l of active) {
    const d = l[l.length - 1];
    const a = byPos.get((d.position as number) - 1);
    if (!a || d.intervalSec === null || d.intervalSec <= P.BATTLE_GAP_SEC) continue;
    const pd = paceOf(l);
    const pa = paceOf(a);
    if (pd === null || pa === null) continue;
    const closing = pa - pd;
    if (closing < P.MIN_CLOSING) continue;
    const laps = (d.intervalSec - P.BATTLE_GAP_SEC) / closing;
    if (lapsLeft !== null && laps > lapsLeft) continue;
    out.push({ chaser: d.driver, ahead: a[a.length - 1].driver, closing, gapSec: d.intervalSec, laps });
  }
  return out.sort((x, y) => x.laps - y.laps);
}
