import type { DriverRow, TimedValue } from "@f1/core";
import { memo } from "react";

const COMPOUND: Record<string, { letter: string; cls: string }> = {
  SOFT: { letter: "S", cls: "soft" },
  MEDIUM: { letter: "M", cls: "medium" },
  HARD: { letter: "H", cls: "hard" },
  INTERMEDIATE: { letter: "I", cls: "inter" },
  WET: { letter: "W", cls: "wet" },
};

/** violeta = mejor absoluto, verde = mejor personal, amarillo = resto */
const timedClass = (t: TimedValue) => (t.ob ? "t-ob" : t.pb ? "t-pb" : "t-plain");

function state(d: DriverRow): string {
  if (d.retired) return "RET";
  if (d.stopped) return "STOP";
  if (d.knockedOut) return "KO";
  if (d.inPit) return "PIT";
  if (d.pitOut) return "OUT";
  return "";
}

interface Props {
  drivers: DriverRow[];
  /** nº de auto → color de su serie en el gráfico de gaps */
  selected: Record<string, string>;
  onToggle: (num: string) => void;
}

export const Tower = memo(function Tower({ drivers, selected, onToggle }: Props) {
  return (
    <div className="panel tower-wrap">
      <table className="tower">
        <thead>
          <tr>
            <th className="num">Pos</th>
            <th>Piloto</th>
            <th className="num">Gap</th>
            <th className="num">Int</th>
            <th className="num">Última</th>
            <th className="num">Mejor</th>
            <th className="num">S1</th>
            <th className="num">S2</th>
            <th className="num">S3</th>
            <th>Neum.</th>
            <th className="num">Pits</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {drivers.map((d) => {
            const out = d.retired || d.stopped || d.knockedOut;
            const c = d.tyre ? (COMPOUND[d.tyre.compound] ?? { letter: "?", cls: "unknown" }) : null;
            const series = selected[d.num];
            return (
              <tr
                key={d.num}
                className={`${out ? "row-out" : ""} ${series ? "row-sel" : ""}`}
                onClick={() => onToggle(d.num)}
                title={`${d.name} · ${d.team}. Clic para sumarlo o sacarlo del gráfico de gaps`}
              >
                <td className="num pos">{d.position}</td>
                <td>
                  <div className="driver">
                    <span className="team-bar" style={{ background: `#${d.color}` }} />
                    <span className="tla">{d.tla}</span>
                    <span className="car-num">{d.num}</span>
                    {series && <span className="series-key" style={{ background: series }} />}
                  </div>
                </td>
                <td className="num">{d.gap}</td>
                <td className={`num ${d.catching ? "catching" : ""}`}>{d.interval}</td>
                <td className={`num ${timedClass(d.lastLap)}`}>{d.lastLap.value}</td>
                <td className="num">{d.bestLap}</td>
                {[0, 1, 2].map((i) => {
                  const s = d.sectors[i];
                  return (
                    <td key={i} className={`num sector ${s ? timedClass(s) : ""}`}>
                      {s?.value}
                    </td>
                  );
                })}
                <td>
                  {c && (
                    <div className="tyre">
                      <span className={`compound ${c.cls}`} title={d.tyre!.compound}>
                        {c.letter}
                      </span>
                      <span className="tyre-age">{d.tyre!.age}</span>
                    </div>
                  )}
                </td>
                <td className="num">{d.pits || ""}</td>
                <td className="state">{state(d)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {!drivers.length && <p className="empty">Todavía no hay datos de tiempos.</p>}
    </div>
  );
});
