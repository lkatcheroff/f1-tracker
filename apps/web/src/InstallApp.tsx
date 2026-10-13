import { useEffect, useState } from "react";

/** El evento que Chrome en Android dispara cuando la app se puede instalar. */
interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

// El evento llega una sola vez y puede ser antes de que el botón exista: se guarda a nivel de módulo.
let saved: InstallPromptEvent | null = null;
const listeners = new Set<() => void>();
if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    saved = e as InstallPromptEvent;
    for (const l of listeners) l();
  });
  window.addEventListener("appinstalled", () => {
    saved = null;
    for (const l of listeners) l();
  });
}

const standalone = () => typeof matchMedia === "function" && matchMedia("(display-mode: standalone)").matches;

/** Botón "Instalar app": aparece solo donde el navegador lo permite y la app todavía no está instalada. */
export function InstallApp() {
  const [, bump] = useState(0);
  useEffect(() => {
    const on = () => bump((n) => n + 1);
    listeners.add(on);
    return () => void listeners.delete(on);
  }, []);
  if (!saved || standalone()) return null;
  const install = async () => {
    const ev = saved;
    if (!ev) return;
    await ev.prompt();
    await ev.userChoice;
    saved = null;
    bump((n) => n + 1);
  };
  return (
    <button type="button" className="btn" onClick={install} title="Instalar F1 Tracker como una app en este dispositivo">
      Instalar app
    </button>
  );
}
