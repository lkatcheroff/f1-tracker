import type { RaceControlMessage } from "@f1/core";
import { memo } from "react";

const MAX = 60;

function tone(m: RaceControlMessage): string {
  if (m.category === "SafetyCar") return "orange";
  switch (m.flag) {
    case "YELLOW":
    case "DOUBLE YELLOW":
      return "yellow";
    case "RED":
      return "red";
    case "GREEN":
    case "CLEAR":
      return "green";
    case "BLUE":
      return "blue";
    case "CHEQUERED":
      return "white";
    default:
      return "none";
  }
}

const time = (utc: string) => {
  const d = new Date(/Z$/.test(utc) ? utc : `${utc}Z`);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
};

export const RaceControl = memo(
  function RaceControl({ messages, count }: { messages: RaceControlMessage[]; count: number }) {
    // `count` cambia solo cuando llega un mensaje nuevo: evita re-renderizar 4 veces por segundo
    const recent = messages.slice(-MAX).reverse();
    return (
      <div className="panel rc">
        <h3>
          Race Control <span className="muted small">{count ? `· ${count} mensajes` : ""}</span>
        </h3>
        {recent.length ? (
          <ol>
            {recent.map((m, i) => (
              <li key={`${count - i}`}>
                <span className={`flag flag-${tone(m)}`} />
                <span className="rc-meta">
                  {time(m.utc)}
                  {m.lap ? ` · V${m.lap}` : ""}
                </span>
                <span className="rc-text">{m.message}</span>
              </li>
            ))}
          </ol>
        ) : (
          <p className="empty">Sin mensajes todavía.</p>
        )}
      </div>
    );
  },
  (a, b) => a.count === b.count,
);
