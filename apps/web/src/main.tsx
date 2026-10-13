import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "uplot/dist/uPlot.min.css";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Sitio publicado: el service worker deja abrir la app sin conexión. Con el server local (desarrollo) no se registra.
if (import.meta.env.MODE === "pages" && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => {});
  });
}
