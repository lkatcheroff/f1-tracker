import type { Params } from "./params";
import type { InsightEvent, LapRow } from "./types";

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const clean = (r: LapRow) => !r.inLap && !r.outLap && !r.neutralized && !r.yellow && r.lap > 1 && r.lapTimeMs !== null;

export function groupByDriver(rows: LapRow[]): Map<string, LapRow[]> {
  const by = new Map<string, LapRow[]>();
  for (const r of rows) {
    let list = by.get(r.driver);
    if (!list) {
      list = [];
      by.set(r.driver, list);
    }
    list.push(r);
  }
  for (const list of by.values()) list.sort((a, b) => a.lap - b.lap);
  return by;
}

/**
 * Cuánto cuesta una parada con los datos de la propia sesión: vuelta de entrada + vuelta de salida − 2 vueltas
 * limpias de ese piloto, con la mediana de todas las paradas en verde. Es una estimación: se rotula como tal.
 * Devuelve null si no hay paradas medibles.
 */
export function estimatePitLoss(byDriver: Map<string, LapRow[]>): number | null {
  const losses: number[] = [];
  for (const rows of byDriver.values()) {
    rows.forEach((r, i) => {
      const out = rows[i + 1];
      if (!r.inLap || !out?.outLap || r.neutralized || out.neutralized || r.lapTimeMs === null || out.lapTimeMs === null) return;
      const pace = rows.filter((x) => clean(x) && x.stint === r.stint).map((x) => x.lapTimeMs as number);
      if (pace.length < 3) return;
      losses.push((r.lapTimeMs + out.lapTimeMs - 2 * median(pace)) / 1000);
    });
  }
  const sane = losses.filter((l) => l > 8 && l < 60);
  return sane.length >= 2 ? median(sane) : null;
}

/**
 * Undercuts y overcuts. Para cada parada de X se mira a su vecino inmediato (delante o detrás) en la vuelta anterior
 * a la entrada, siempre que estén a menos de lo que cuesta una parada más `PAIR_MARGIN_SEC`; y que ese vecino Y pare
 * después, dentro de `UNDERCUT_MAX_LAPS` vueltas. Se compara quién iba delante antes y quién va delante `SETTLE_LAPS`
 * vueltas después de que sale Y:
 *
 *   Y delante → X delante   undercut exitoso de X        Y delante → Y delante   undercut fallido de X
 *   X delante → Y delante   overcut exitoso de Y         X delante → X delante   sin evento
 *
 * (La spec define el par con Y inmediatamente delante; la tabla incluye el overcut, que necesita a X delante: se
 * miran los dos vecinos.) Se descartan los pares con vueltas neutralizadas entre las paradas, con un retiro o con
 * datos de diferencia faltantes (doblados).
 */
export function findStrategyEvents(rows: LapRow[], P: Params, pitLossSec: number, estimated: boolean): InsightEvent[] {
  const by = groupByDriver(rows);
  const at = (num: string, lap: number) => by.get(num)?.find((r) => r.lap === lap);
  const lastLap = (num: string) => by.get(num)?.at(-1)?.lap ?? 0;
  const events: InsightEvent[] = [];
  const seen = new Set<string>();

  for (const [x, xrows] of by) {
    for (const xin of xrows.filter((r) => r.inLap && r.lap > 1)) {
      const before = at(x, xin.lap - 1);
      if (!before || before.position === null || before.neutralized) continue;
      for (const delta of [-1, 1]) {
        const yBefore = [...by.values()]
          .map((l) => l.find((r) => r.lap === xin.lap - 1 && r.position === before.position! + delta))
          .find(Boolean);
        if (!yBefore) continue;
        const y = yBefore.driver;
        const gapBetween = delta === -1 ? before.intervalSec : yBefore.intervalSec; // el de atrás respecto del de adelante
        if (gapBetween === null || gapBetween > pitLossSec + P.PAIR_MARGIN_SEC) continue;

        // Y para después de X, dentro de la ventana
        const yin = by.get(y)?.find((r) => r.inLap && r.lap > xin.lap && r.lap <= xin.lap + P.UNDERCUT_MAX_LAPS);
        if (!yin) continue;
        const lapAfter = yin.lap + 1 + P.SETTLE_LAPS;
        if (lastLap(x) < lapAfter || lastLap(y) < lapAfter) continue;
        const between = [x, y].flatMap((d) => (by.get(d) ?? []).filter((r) => r.lap >= xin.lap && r.lap <= lapAfter));
        if (between.some((r) => r.neutralized)) continue;

        const xa = at(x, lapAfter);
        const ya = at(y, lapAfter);
        const yb = at(y, xin.lap - 1);
        if (!xa || !ya || !yb || xa.position === null || ya.position === null) continue;
        const gaps = [before.gapLeaderSec, yb.gapLeaderSec, xa.gapLeaderSec, ya.gapLeaderSec];
        if (gaps.some((g) => g === null)) continue;

        const yAheadBefore = delta === -1;
        const yAheadAfter = ya.position < xa.position;
        // d = cuánto va Y detrás de X (negativo si Y va delante)
        const dBefore = (yb.gapLeaderSec as number) - (before.gapLeaderSec as number);
        const dAfter = (ya.gapLeaderSec as number) - (xa.gapLeaderSec as number);
        let kind: "undercut" | "overcut";
        let success: boolean;
        let protagonist: string;
        let rival: string;
        let gain: number;
        if (yAheadBefore) {
          kind = "undercut";
          success = !yAheadAfter;
          protagonist = x;
          rival = y;
          gain = dAfter - dBefore; // lo que mejoró X frente a Y
        } else if (yAheadAfter) {
          kind = "overcut";
          success = true;
          protagonist = y;
          rival = x;
          gain = dBefore - dAfter; // lo que mejoró Y frente a X
        } else continue;

        const key = `${kind}:${x}:${y}:${xin.lap}`;
        if (seen.has(key)) continue;
        seen.add(key);
        events.push({
          id: "",
          kind,
          ts: Math.max(xa.endTs, ya.endTs),
          seekTs: xin.startTs,
          lap: xin.lap,
          drivers: [protagonist, rival],
          data: {
            success,
            gainSec: Math.round(gain * 10) / 10,
            lapsBetween: yin.lap - xin.lap,
            firstToStop: x,
            pitLossSec: Math.round(pitLossSec * 10) / 10,
          },
          confidence: estimated ? "approx" : "high",
        });
      }
    }
  }
  return events;
}
