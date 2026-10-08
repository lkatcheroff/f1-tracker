import { idealLaps, type SessionInsights } from "@f1/core";
import { memo, useMemo } from "react";
import { fmtLapMs, fmtSecMs } from "./format";

interface Props {
  insights: SessionInsights;
  now: number;
}

/** Vuelta ideal (práctica y clasificación): la suma de los mejores sectores de cada piloto contra su mejor vuelta real. */
export const IdealPanel = memo(function IdealPanel({ insights, now }: Props) {
  const closed = useMemo(() => insights.laps.filter((l) => l.endTs <= now).length, [insights.laps, now]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `closed` es la huella de `now` a nivel de vuelta
  const rows = useMemo(() => idealLaps(insights.laps.filter((l) => l.endTs <= now)), [insights.laps, closed]);
  const shown = rows.filter((r) => r.idealMs !== null);
  const best = shown[0]?.idealMs ?? null;
  const tla = (n: string) => insights.drivers[n]?.tla ?? n;

  return (
    <div className="panel ideal">
      <h3>Vuelta ideal</h3>
      <p className="chart-note">
        La suma de los mejores S1, S2 y S3 de cada piloto, contra su mejor vuelta real. Incluye sectores de vueltas que pueden haber sido
        anuladas.
      </p>
      {shown.length ? (
        <table className="tel-table">
          <thead>
            <tr>
              <th>Piloto</th>
              <th className="num">Mejor</th>
              <th className="num">Ideal</th>
              <th className="num">Dejó en la mesa</th>
              <th>Limita</th>
            </tr>
          </thead>
          <tbody>
            {shown.slice(0, 22).map((r) => (
              <tr key={r.driver}>
                <td>{tla(r.driver)}</td>
                <td className="num">{r.bestMs !== null ? fmtLapMs(r.bestMs) : "–"}</td>
                <td className="num">
                  {fmtLapMs(r.idealMs as number)}
                  {best !== null && r.idealMs !== best && <span className="muted"> +{fmtSecMs((r.idealMs as number) - best)}</span>}
                </td>
                <td className={`num ${r.lossMs && r.lossMs > 150 ? "d-loss" : ""}`}>
                  {r.lossMs !== null ? `${fmtSecMs(r.lossMs)} s` : "–"}
                </td>
                <td>{r.limiting !== null ? `S${r.limiting + 1}` : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="empty">Todavía no hay pilotos con los tres sectores medidos.</p>
      )}
    </div>
  );
});
