import type { LiveState } from "@f1/core";

const STATUS: Record<LiveState["status"], string> = {
  connecting: "Conectando al feed de F1…",
  connected: "Conectado al feed de F1",
  reconnecting: "Reconectando…",
  closed: "Desconectado",
};

/** Qué deja de funcionar cuando falta un topic. */
const IMPACT: Record<string, string> = {
  "Position.z": "sin mapa",
  "CarData.z": "sin telemetría",
  TimingData: "sin tiempos ni gaps",
  TimingAppData: "sin neumáticos",
  LapCount: "sin contador de vueltas (solo carreras)",
};

function age(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 90 ? `hace ${s} s` : `hace ${Math.round(s / 60)} min`;
}

/** Salud del modo live: el feed sin cuenta es best-effort, así que se muestra qué llega y qué no. */
export function LivePanel({ live, now }: { live: LiveState; now: number }) {
  const missing = live.subscribed.filter((t) => !live.topics[t]);
  return (
    <section className="controls live-panel" aria-label="Estado del feed en vivo">
      <div className="ctl-row">
        <span className={`dot dot-${live.status}`} />
        <strong>{STATUS[live.status]}</strong>
        {live.detail && <span className="muted">({live.detail})</span>}
        <span className="muted">
          {live.recording ? `Grabando en data/recordings/${live.recording}` : "La grabación arranca cuando empieza a llegar la sesión"}
        </span>
      </div>
      {live.status === "connected" && (
        <div className="topics">
          {live.subscribed.map((t) => {
            const h = live.topics[t];
            return (
              <span
                key={t}
                className={`topic ${h ? "topic-ok" : "topic-missing"}`}
                title={h ? `${h.count} mensajes, último ${age(now - h.lastTs)}` : "No llegó ningún dato"}
              >
                {h ? "✓" : "✕"} {t}
                {h ? <span className="muted"> {h.count}</span> : IMPACT[t] ? <span className="muted"> · {IMPACT[t]}</span> : null}
              </span>
            );
          })}
        </div>
      )}
      {live.status === "connected" && missing.includes("Position.z") && (
        <p className="muted small">
          Sin cuenta de F1, el feed no manda posiciones ni telemetría. El resto funciona; el replay del archivo oficial sí trae el mapa.
        </p>
      )}
    </section>
  );
}
