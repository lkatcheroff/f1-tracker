const REPO = "https://github.com/lkatcheroff/f1-tracker";

/** Pie de todas las pantallas: de dónde salen los datos y que el proyecto no es oficial. */
export function Footer() {
  return (
    <footer className="foot">
      <p>
        Proyecto personal y <strong>no oficial</strong>. No tiene relación con Formula 1, la FIA ni sus marcas: F1 y los nombres
        relacionados son de sus dueños.
      </p>
      <p>
        Datos de{" "}
        <a href="https://openf1.org" target="_blank" rel="noreferrer">
          OpenF1
        </a>{" "}
        y de los archivos de tiempos de F1; trazados y curvas de{" "}
        <a href="https://multiviewer.app" target="_blank" rel="noreferrer">
          MultiViewer
        </a>
        . Código abierto (MIT) en{" "}
        <a href={REPO} target="_blank" rel="noreferrer">
          GitHub
        </a>
        .
      </p>
    </footer>
  );
}
