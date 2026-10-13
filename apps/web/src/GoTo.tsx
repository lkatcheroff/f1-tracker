import { type ClockAnchor, clockParts, parseRemainingInput, partLength, tsAtRemaining } from "@f1/core";
import { useState } from "react";
import { fmtDuration } from "./format";

interface Props {
  clock: ClockAnchor[];
  duration: number;
  /** parte en la que está la reproducción ahora (null en práctica) */
  currentPart: number | null;
  onGo: (ts: number) => void;
}

const SHORTCUTS: { label: string; ms: number | "start" }[] = [
  { label: "Inicio", ms: "start" },
  { label: "10:00", ms: 10 * 60_000 },
  { label: "5:00", ms: 5 * 60_000 },
  { label: "1:00", ms: 60_000 },
  { label: "Fin", ms: 0 },
];

/** "Ir a cuando faltan 3:15 de la Q2": salta por el tiempo de la sesión, no por el de la grabación. */
export function GoTo({ clock, duration, currentPart, onGo }: Props) {
  const parts = clockParts(clock);
  const [part, setPart] = useState<number | null>(currentPart ?? parts[0] ?? null);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const label = part === null ? "la sesión" : `la Q${part}`;
  const length = partLength(clock, part);

  const go = (ms: number | "start") => {
    const remaining = ms === "start" ? length : ms;
    const ts = tsAtRemaining(clock, part, remaining, duration);
    if (ts === null) {
      setError(`En ${label} no hay un momento con ${fmtDuration(remaining)} restantes (dura ${fmtDuration(length)}).`);
      return;
    }
    setError(null);
    onGo(ts);
  };
  const submit = () => {
    const ms = parseRemainingInput(text);
    if (ms === null) setError("Escribí el tiempo que falta como minutos y segundos, por ejemplo 3:15.");
    else go(ms);
  };

  return (
    <form
      className="goto"
      aria-label="Ir a un momento por el tiempo de sesión"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      {parts.length > 0 && (
        <label className="field">
          Parte
          <select value={part ?? ""} onChange={(e) => setPart(Number(e.target.value))}>
            {parts.map((p) => (
              <option key={p} value={p}>
                Q{p}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="field">
        Faltan
        <input
          type="text"
          inputMode="numeric"
          autoComplete="off"
          placeholder="mm:ss"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setError(null);
          }}
          aria-invalid={error !== null}
          className="goto-input"
        />
      </label>
      <button type="submit" className="btn btn-primary">
        Ir
      </button>
      <span className="btn-group goto-short">
        {SHORTCUTS.map((s) => (
          <button type="button" key={s.label} className="btn" onClick={() => go(s.ms)}>
            {s.label}
          </button>
        ))}
      </span>
      {error && (
        <p className="goto-error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
