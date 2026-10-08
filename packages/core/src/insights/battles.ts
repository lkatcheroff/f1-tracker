import type { Params } from "./params";
import type { Battle, InsightEvent, LapRow } from "./types";

/**
 * Duelos: dos autos consecutivos a menos de `BATTLE_GAP_SEC` durante `BATTLE_MIN_LAPS` vueltas seguidas, ambos en pista
 * y sin neutralización. Terminan cuando el intervalo supera `BATTLE_END_GAP_SEC` (o dejan de ir consecutivos) durante
 * `BATTLE_END_LAPS` vueltas. El resultado es "passed" si el orden cambió, y "held" si no.
 */
export function findBattles(rows: LapRow[], P: Params): { battles: Battle[]; events: InsightEvent[] } {
  const byLap = new Map<number, LapRow[]>();
  for (const r of rows) {
    let list = byLap.get(r.lap);
    if (!list) {
      list = [];
      byLap.set(r.lap, list);
    }
    list.push(r);
  }

  interface Live {
    battle: Battle;
    lastAhead: string;
    far: number;
  }
  const streak = new Map<string, { n: number; first: number; chaser: string; ahead: string }>();
  const live = new Map<string, Live>();
  const battles: Battle[] = [];
  const events: InsightEvent[] = [];
  const key = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

  for (const lap of [...byLap.keys()].sort((a, b) => a - b)) {
    const list = byLap.get(lap) ?? [];
    const byPos = new Map(list.filter((r) => r.position !== null).map((r) => [r.position as number, r]));
    const seen = new Set<string>();
    for (const d of list) {
      if (d.position === null || d.position < 2) continue;
      const a = byPos.get(d.position - 1);
      if (!a) continue;
      const k = key(d.driver, a.driver);
      seen.add(k);
      if (d.neutralized || a.neutralized) continue; // bajo neutralización los gaps se comprimen: ni suma ni resta
      // La vuelta 1 sale desde parado: los intervalos son los de la grilla, no un duelo.
      const dirty = lap <= 1 || d.inLap || d.outLap || a.inLap || a.outLap || d.intervalSec === null;
      const close = !dirty && (d.intervalSec as number) <= P.BATTLE_GAP_SEC;

      const l = live.get(k);
      if (l) {
        l.lastAhead = a.driver;
        const far = dirty || (d.intervalSec as number) > P.BATTLE_END_GAP_SEC;
        l.far = far ? l.far + 1 : 0;
        if (l.far >= P.BATTLE_END_LAPS) closeBattle(l, lap, Math.max(d.endTs, a.endTs));
        continue;
      }
      const s = streak.get(k);
      if (close) {
        const cur = s ? { ...s, n: s.n + 1 } : { n: 1, first: lap, chaser: d.driver, ahead: a.driver };
        streak.set(k, cur);
        if (cur.n >= P.BATTLE_MIN_LAPS) {
          const startTs = Math.max(d.endTs, a.endTs);
          const battle: Battle = {
            chaser: cur.chaser,
            ahead: cur.ahead,
            fromLap: cur.first,
            declaredLap: lap,
            startTs,
            endTs: null,
            endLap: null,
            result: "open",
          };
          battles.push(battle);
          live.set(k, { battle, lastAhead: a.driver, far: 0 });
          streak.delete(k);
          events.push({
            id: "",
            kind: "battle",
            ts: startTs,
            seekTs: rows.find((r) => r.driver === cur.chaser && r.lap === cur.first)?.startTs ?? startTs,
            lap,
            drivers: [cur.chaser, cur.ahead],
            data: { phase: "start", gapSec: Math.round((d.intervalSec as number) * 10) / 10, laps: cur.n },
            confidence: "high",
          });
        }
      } else streak.delete(k);
    }
    // pares que dejaron de ser consecutivos (uno paró o se retiró)
    for (const [k, l] of live) {
      if (seen.has(k)) continue;
      l.far++;
      if (l.far >= P.BATTLE_END_LAPS)
        closeBattle(
          l,
          lap,
          rows.filter((r) => r.lap === lap).reduce((m, r) => Math.max(m, r.endTs), 0),
        );
    }
    for (const k of [...streak.keys()]) if (!seen.has(k)) streak.delete(k);
  }

  function closeBattle(l: Live, lap: number, ts: number) {
    live.delete(key(l.battle.chaser, l.battle.ahead));
    l.battle.endTs = ts;
    l.battle.endLap = lap;
    l.battle.result = l.lastAhead === l.battle.ahead ? "held" : "passed";
    events.push({
      id: "",
      kind: "battle",
      ts,
      seekTs: ts,
      lap,
      drivers: [l.battle.chaser, l.battle.ahead],
      data: { phase: "end", result: l.battle.result, laps: lap - l.battle.fromLap },
      confidence: "high",
    });
  }
  return { battles, events };
}

/** Los duelos en curso en `now` (los que ya se declararon y todavía no terminaron). */
export function activeBattles(battles: Battle[], now: number): Battle[] {
  return battles.filter((b) => b.startTs <= now && (b.endTs === null || b.endTs > now));
}
