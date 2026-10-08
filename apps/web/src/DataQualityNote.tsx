import type { SessionInsights } from "@f1/core";

const WHERE = { openf1: "OpenF1", recording: "una grabación del feed en vivo", official: "el archivo oficial" } as const;

/**
 * Aviso por sesión: si los datos no vienen del archivo oficial, dice qué se aproxima o falta.
 * No aparece cuando la fuente no declara nada que avisar.
 */
export function DataQualityNote({ insights }: { insights: SessionInsights }) {
  const q = insights.dataQuality;
  if (!q.approximations.length) return null;
  return (
    <details className="quality notice">
      <summary>
        Datos de {WHERE[q.source]}: <strong>algunas cosas son aproximadas</strong>
      </summary>
      <ul>
        {q.approximations.map((a) => (
          <li key={a}>{a}</li>
        ))}
      </ul>
      <p className="muted small">Los eventos que dependen de estas aproximaciones llevan un ≈ delante.</p>
    </details>
  );
}
