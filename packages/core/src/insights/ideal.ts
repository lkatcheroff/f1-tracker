import type { LapRow } from "./types";

export interface IdealRow {
  driver: string;
  /** mejor vuelta real, ms */
  bestMs: number | null;
  /** suma de sus mejores S1, S2 y S3 (de vueltas distintas), ms; null si le falta algún sector */
  idealMs: number | null;
  /** sus mejores tiempos de sector */
  sectors: [number | null, number | null, number | null];
  /** cuánto le sobró a su mejor vuelta contra la ideal, ms */
  lossMs: number | null;
  /** sector donde su mejor vuelta se aleja más de su mejor sector (0, 1 o 2) */
  limiting: 0 | 1 | 2 | null;
}

/**
 * Vuelta ideal por piloto: la suma de sus mejores sectores de la sesión, contra su mejor vuelta real. La diferencia
 * es lo que "dejó en la mesa", y el sector limitante es donde su mejor vuelta está más lejos de su mejor tiempo.
 * Incluye sectores de vueltas que pueden haber sido anuladas (el feed no lo informa en la tabla de tiempos).
 * `rows` ya tiene que venir filtrado hasta el instante actual.
 */
export function idealLaps(rows: LapRow[]): IdealRow[] {
  const by = new Map<string, LapRow[]>();
  for (const r of rows) {
    let list = by.get(r.driver);
    if (!list) {
      list = [];
      by.set(r.driver, list);
    }
    list.push(r);
  }
  const out: IdealRow[] = [];
  for (const [driver, laps] of by) {
    const sectors: IdealRow["sectors"] = [null, null, null];
    for (const l of laps) {
      for (let i = 0; i < 3; i++) {
        const t = l.sectorsMs[i];
        if (t !== null && (sectors[i] === null || t < sectors[i]!)) sectors[i] = t;
      }
    }
    let best: LapRow | null = null;
    for (const l of laps) if (l.lapTimeMs !== null && (best === null || l.lapTimeMs < best.lapTimeMs!)) best = l;
    const idealMs = sectors.every((s) => s !== null) ? (sectors as number[]).reduce((a, b) => a + b, 0) : null;
    let limiting: IdealRow["limiting"] = null;
    if (best && sectors.every((s) => s !== null)) {
      let worst = 0;
      for (let i = 0; i < 3; i++) {
        const bt = best.sectorsMs[i];
        if (bt === null) continue;
        const loss = bt - (sectors[i] as number);
        if (loss > worst) {
          worst = loss;
          limiting = i as 0 | 1 | 2;
        }
      }
    }
    out.push({
      driver,
      bestMs: best?.lapTimeMs ?? null,
      idealMs,
      sectors,
      lossMs: idealMs !== null && best?.lapTimeMs != null ? best.lapTimeMs - idealMs : null,
      limiting,
    });
  }
  return out.sort((a, b) => (a.idealMs ?? Number.POSITIVE_INFINITY) - (b.idealMs ?? Number.POSITIVE_INFINITY));
}
