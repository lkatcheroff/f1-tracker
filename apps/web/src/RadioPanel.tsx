import { type RadioClip, type RadioTranscripts, radioId, radioTranscriptFile, type SessionInsights, shortName } from "@f1/core";
import { useEffect, useRef, useState } from "react";
import { fmtDuration } from "./format";
import { loadTranscripts } from "./transport";

interface Props {
  clips: RadioClip[];
  drivers: SessionInsights["drivers"];
  /** momento de la largada, para mostrar la hora de cada mensaje contada desde ahí */
  startTs: number | null;
  onJump: (ts: number) => void;
}

const SHOWN = 8;

/** La radio de los equipos: mensajes de audio, del más nuevo al más viejo, solo los que ya pasaron. */
export function RadioPanel({ clips, drivers, startTs, onJump }: Props) {
  const audio = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  const [texts, setTexts] = useState<RadioTranscripts>({});

  // Transcripciones automáticas: un archivo por sesión; si no existe, el panel sigue sin texto.
  const files = [...new Set(clips.map((c) => radioTranscriptFile(c.url)).filter((f): f is string => !!f))].join(",");
  useEffect(() => {
    let live = true;
    Promise.all(files.split(",").filter(Boolean).map(loadTranscripts)).then((all) => {
      if (live) setTexts(Object.assign({}, ...all));
    });
    return () => {
      live = false;
    };
  }, [files]);

  // Al salir de la pantalla, el audio se corta.
  useEffect(() => () => audio.current?.pause(), []);

  if (!clips.length) return null;
  const list = [...clips].reverse();
  const shown = all ? list : list.slice(0, SHOWN);

  const toggle = (url: string) => {
    const el = audio.current;
    if (!el) return;
    setFailed(null);
    if (playing === url) {
      el.pause();
      setPlaying(null);
      return;
    }
    el.src = url;
    el.play().then(
      () => setPlaying(url),
      () => {
        setPlaying(null);
        setFailed(url);
      },
    );
  };

  return (
    <section className="panel radio" aria-label="Radio de los equipos">
      <h3>Radio</h3>
      {/* biome-ignore lint/a11y/useMediaCaption: son mensajes de radio de F1 sin transcripción disponible */}
      <audio
        ref={audio}
        onEnded={() => setPlaying(null)}
        onPause={() => setPlaying((p) => (audio.current?.ended ? null : p))}
        preload="none"
      />
      <ul className="radio-list">
        {shown.map((c) => {
          const name = shortName(drivers[c.driver], c.driver);
          const on = playing === c.url;
          return (
            <li key={`${c.ts}:${c.driver}`} className={on ? "radio-on" : ""}>
              <button
                type="button"
                className="btn radio-play"
                onClick={() => toggle(c.url)}
                aria-pressed={on}
                aria-label={`${on ? "Pausar" : "Escuchar"} el mensaje de ${name}`}
              >
                {on ? "❚❚" : "▶"}
              </button>
              <span className="radio-who">
                <strong>{drivers[c.driver]?.tla ?? c.driver}</strong> <span className="muted">{name}</span>
              </span>
              <button type="button" className="linklike radio-at" onClick={() => onJump(c.ts)} title="Ir al momento de este mensaje">
                {fmtDuration(startTs !== null ? c.ts - startTs : c.ts)}
              </button>
              {texts[radioId(c.url) ?? ""]?.text && <p className="radio-text">“{texts[radioId(c.url) ?? ""].text}”</p>}
              {failed === c.url && <span className="radio-error">No se pudo cargar el audio.</span>}
            </li>
          );
        })}
      </ul>
      {Object.keys(texts).length > 0 && (
        <p className="muted small">Transcripción automática: puede tener errores, sobre todo con nombres y jerga.</p>
      )}
      {list.length > SHOWN && (
        <button type="button" className="linklike" onClick={() => setAll((v) => !v)}>
          {all ? "Ver menos" : `Ver los ${list.length}`}
        </button>
      )}
    </section>
  );
}
