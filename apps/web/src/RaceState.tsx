import type { InsightEvent, SessionInsights, Snapshot } from "@f1/core";
import { describe } from "@f1/core";
import { TRACK_STATUS } from "./format";

interface Props {
  snap: Snapshot;
  insights: SessionInsights;
  events: InsightEvent[];
}

/** La carrera en una tarjeta: quién lidera, a cuánto está el segundo, quién está en boxes, el estado de pista y lo último. */
export function RaceState({ snap, insights, events }: Props) {
  const [first, second] = snap.drivers;
  if (!first || !snap.lap) return null;
  const inPit = snap.drivers.filter((d) => d.inPit && !d.retired && !d.stopped);
  const track = TRACK_STATUS[snap.track.status];
  const last = events
    .filter((e) => e.kind !== "investigation" && e.kind !== "battle")
    .slice(-3)
    .reverse();
  return (
    <div className="panel race-state">
      <h3>Estado de carrera</h3>
      <dl>
        <div>
          <dt>Líder</dt>
          <dd>
            <span className="team-bar" style={{ background: `#${first.color}` }} /> {first.tla}
            {second && (
              <span className="muted">
                {" "}
                · el 2.º, {second.tla}, a {second.gap || "–"}
              </span>
            )}
          </dd>
        </div>
        <div>
          <dt>Pista</dt>
          <dd>
            <span className={`flag flag-${track?.tone ?? "none"}`} /> {track?.label ?? "–"}
          </dd>
        </div>
        <div>
          <dt>En boxes</dt>
          <dd>{inPit.length ? inPit.map((d) => d.tla).join(", ") : <span className="muted">nadie</span>}</dd>
        </div>
      </dl>
      {last.length > 0 && (
        <ul className="state-last">
          {last.map((e) => (
            <li key={e.id}>{describe(e, { drivers: insights.drivers })}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
