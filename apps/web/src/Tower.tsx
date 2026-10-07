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
  /** Clasificación: cuántos pasan de ronda; agrega la columna de corte y marca la zona de eliminación. */
  through: number | null;
  /** nº de auto → color de su serie en el gráfico de gaps */
  selected: Record<string, string>;
  onToggle: (num: string) => void;
}

/** Estado de un mini-sector del feed → clase y texto. */
function miniClass(code: number): string {
  if (!code) return "m-none";
  if (code === 2051) return "m-purple";
  if (code === 2049) return "m-green";
  if (code === 2064) return "m-pit";
  return "m-yellow";
}
const MINI_TEXT: Record<string, string> = {
  "m-none": "sin pasar",
  "m-yellow": "sin mejora",
  "m-green": "mejor marca personal",
  "m-purple": "mejor marca de la sesión",
  "m-pit": "calle de boxes",
};

/** Los mini-sectores de un sector, como una barrita de colores: violeta = mejor de la sesión, verde = mejor propio, amarillo = sin mejora. */
function Minis({ codes }: { codes: number[] | undefined }) {
  if (!codes?.length) return null;
  return (
    <span className="minis" aria-hidden="true">
      {codes.map((c, i) => {
        const cls = miniClass(c);
        return <i key={i} className={cls} title={`Mini-sector ${i + 1}: ${MINI_TEXT[cls]}`} />;
      })}
    </span>
  );
}

const fmtCut = (g: number) => `${g >= 0 ? "+" : "−"}${Math.abs(g).toFixed(3)}`;

export const Tower = memo(function Tower({ drivers, through, selected, onToggle }: Props) {
  const cut = through !== null;
  const lastSafe = cut ? drivers.filter((d) => !d.knockedOut && !d.retired)[through - 1]?.num : null;
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
            {cut && (
              <th className="num" title="Margen respecto del corte: + lo que le sobra al que pasa, − lo que le falta al que está afuera">
                Corte
              </th>
            )}
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
                className={`${out ? "row-out" : ""} ${series ? "row-sel" : ""} ${d.inCutZone ? "row-cut" : ""} ${d.num === lastSafe ? "row-last-safe" : ""}`}
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
                {cut && (
                  <td className={`num cut ${d.inCutZone ? "cut-out" : "cut-safe"}`}>
                    {d.knockedOut ? "" : d.cutGap === null ? (d.inCutZone ? "sin tiempo" : "") : fmtCut(d.cutGap)}
                  </td>
                )}
                {[0, 1, 2].map((i) => {
                  const s = d.sectors[i];
                  return (
                    <td key={i} className={`num sector ${s ? timedClass(s) : ""}`}>
                      {s?.value}
                      <Minis codes={d.minis[i]} />
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
      {cut && drivers.length > 0 && (
        <p className="tower-note">
          Pasan los primeros {through}. La línea roja es el corte; abajo, en rojo, los que hoy quedan afuera. Corte: + lo que le sobra, − lo que le
          falta.
        </p>
      )}
    </div>
  );
});
