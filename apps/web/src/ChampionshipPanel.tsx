import type { Championship, SessionInsights } from "@f1/core";
import { useState } from "react";

const move = (from: number, to: number) =>
  to < from ? (
    <span className="ch-up">▲ {from - to}</span>
  ) : to > from ? (
    <span className="ch-down">▼ {to - from}</span>
  ) : (
    <span className="muted">=</span>
  );
const pts = (n: number) => String(n).replace(".", ",");

/** El campeonato antes y después de la carrera. Solo existe cuando la carrera ya terminó. */
export function ChampionshipPanel({ data, drivers }: { data: Championship; drivers: SessionInsights["drivers"] }) {
  const [teams, setTeams] = useState(false);
  const [all, setAll] = useState(false);
  const rows = (teams ? data.teams : data.drivers).slice().sort((a, b) => a.pos - b.pos);
  const shown = all ? rows : rows.slice(0, 10);
  const colorOfTeam = (team: string) => Object.values(drivers).find((d) => d.team === team)?.color ?? "888888";
  return (
    <section className="panel champ" aria-label="Campeonato">
      <div className="events-head">
        <h3>Campeonato</h3>
        <fieldset className="btn-group bare" aria-label="Ver">
          <button type="button" className={`btn btn-small ${teams ? "" : "btn-on"}`} onClick={() => setTeams(false)}>
            Pilotos
          </button>
          <button type="button" className={`btn btn-small ${teams ? "btn-on" : ""}`} onClick={() => setTeams(true)}>
            Equipos
          </button>
        </fieldset>
      </div>
      <table className="champ-table">
        <thead>
          <tr>
            <th className="num">Pos</th>
            <th />
            <th>{teams ? "Equipo" : "Piloto"}</th>
            <th className="num">Pts</th>
            <th className="num">Carrera</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((r) => {
            const key = "driver" in r ? r.driver : r.team;
            const d = "driver" in r ? drivers[r.driver] : undefined;
            const color = "driver" in r ? (d?.color ?? "888888") : colorOfTeam(r.team);
            return (
              <tr key={key}>
                <td className="num">{r.pos}</td>
                <td className="ch-move">{move(r.posStart, r.pos)}</td>
                <td>
                  <span className="team-bar" style={{ background: `#${color}` }} /> {"driver" in r ? (d?.tla ?? r.driver) : r.team}
                </td>
                <td className="num">{pts(r.pts)}</td>
                <td className="num muted">{r.pts - r.ptsStart > 0 ? `+${pts(r.pts - r.ptsStart)}` : ""}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {rows.length > 10 && (
        <button type="button" className="linklike" onClick={() => setAll((v) => !v)}>
          {all ? "Ver menos" : `Ver los ${rows.length}`}
        </button>
      )}
    </section>
  );
}
