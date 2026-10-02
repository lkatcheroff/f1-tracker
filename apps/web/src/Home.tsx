import type { MeetingEntry, SessionEntry, SessionsResponse } from "@f1/core";
import { useEffect, useState } from "react";
import { fmtLocalDateTime, store } from "./format";
import { loadSessions, STATIC } from "./transport";

const THIS_YEAR = new Date().getFullYear();
const YEARS = Array.from({ length: Math.max(1, THIS_YEAR - 2022) }, (_, i) => THIS_YEAR - i);

const replayHref = (source: string) => `#/replay/${encodeURIComponent(source)}`;
const hasProgress = (source: string) => store.get<{ time?: number }>(`f1t:pos:${source}`, {}).time !== undefined;

function SessionChip({ s, now }: { s: SessionEntry; now: number }) {
  const start = Date.parse(s.startUtc);
  const end = Date.parse(s.endUtc);
  // Sitio estático: la sesión ya procesada que publicó la Action. Con server: el archivo de F1.
  const ready = STATIC ? (s.data ? `mirror:${s.data}` : null) : s.path ? `static:${s.path}` : null;
  if (ready) {
    const source = ready;
    return (
      <a className="chip" href={replayHref(source)}>
        {s.name}
        {hasProgress(source) && <span className="chip-note">retomar</span>}
      </a>
    );
  }
  // Ventana amplia: las sesiones se pasan de hora y F1 tarda ~30 min en publicar el archivo.
  if (!STATIC && now > start - 20 * 60_000 && now < end + 90 * 60_000) {
    return (
      <span className="chip-group">
        <a className="chip chip-live" href="#/live">
          {s.name} · en vivo
        </a>
        {now > end && (
          <a className="chip" href={replayHref(`openf1:${s.startUtc}`)}>
            vía OpenF1
          </a>
        )}
      </span>
    );
  }
  if (now >= end + (STATIC ? 30 * 60_000 : 0)) {
    return (
      <a className="chip" href={replayHref(`openf1:${s.startUtc}`)}>
        {s.name}
        <span className="chip-note">vía OpenF1</span>
      </a>
    );
  }
  return (
    <span className="chip chip-off">
      {s.name}
      <span className="chip-note">{now > start ? "disponible unos 30 min después del final" : fmtLocalDateTime(s.startUtc)}</span>
    </span>
  );
}

function Meeting({ m, now }: { m: MeetingEntry; now: number }) {
  return (
    <li className="meeting">
      <div className="meeting-name">
        {m.name}
        <span className="muted"> · {m.location}</span>
      </div>
      <div className="chips">
        {m.sessions.map((s) => (
          <SessionChip key={s.key} s={s} now={now} />
        ))}
      </div>
    </li>
  );
}

/** Lista de sesiones. No muestra resultados: solo nombres y horarios. */
export function Home() {
  const [year, setYear] = useState(THIS_YEAR);
  const [data, setData] = useState<SessionsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stale = false;
    setData(null);
    setError(null);
    loadSessions(year)
      .then((d: SessionsResponse) => !stale && setData(d))
      .catch((e: Error) => !stale && setError(e.message));
    return () => {
      stale = true;
    };
  }, [year]);

  const now = Date.now();
  // Solo fines de semana que ya empezaron o empiezan en los próximos días, del más reciente al más viejo.
  const meetings = (data?.meetings ?? [])
    .filter((m) => m.sessions.length && Date.parse(m.sessions[0].startUtc) < now + 7 * 86_400_000)
    .reverse();

  return (
    <main className="home">
      <header className="home-head">
        <h1>F1 Tracker</h1>
        {!STATIC && (
          <a className="btn btn-primary" href="#/live">
            Seguir en vivo
          </a>
        )}
        <label className="field">
          Temporada
          <select value={year} onChange={(e) => setYear(Number(e.target.value))}>
            {YEARS.map((y) => (
              <option key={y}>{y}</option>
            ))}
          </select>
        </label>
      </header>

      {error && <p className="notice notice-error">No se pudo cargar el calendario: {error}</p>}
      {!data && !error && <p className="muted">Cargando calendario…</p>}

      {!!data?.recordings.length && (
        <section>
          <h2>Grabaciones propias</h2>
          <div className="chips">
            {data.recordings.map((r) => (
              <a key={r.file} className="chip" href={replayHref(`rec:${r.file}`)}>
                {r.label}
                <span className="chip-note">{(r.sizeKb / 1024).toFixed(1)} MB</span>
              </a>
            ))}
          </div>
        </section>
      )}

      {data && (
        <section>
          <h2>Sesiones {data.year}</h2>
          {meetings.length ? (
            <ul className="meetings">
              {meetings.map((m) => (
                <Meeting key={m.key} m={m} now={now} />
              ))}
            </ul>
          ) : (
            <p className="muted">No hay sesiones para esta temporada.</p>
          )}
        </section>
      )}
      <footer className="muted small">
        {STATIC && "Las sesiones nuevas aparecen solas, entre 30 y 60 minutos después de que terminan. "}
        Proyecto personal no oficial, sin afiliación con Formula 1.
      </footer>
    </main>
  );
}
