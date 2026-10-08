import { useEffect, useState } from "react";

/** Breakpoints del diseño: ≤720 es teléfono (una columna, pestañas); ≤1080, tablet (una columna). */
export const PHONE = "(max-width: 720px)";

/** `true` mientras la ventana cumple la media query. Sin `matchMedia` (tests, SSR) devuelve `false`. */
export function useMediaQuery(query: string): boolean {
  const get = () => (typeof matchMedia === "function" ? matchMedia(query).matches : false);
  const [match, setMatch] = useState(get);
  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const mq = matchMedia(query);
    const on = () => setMatch(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [query]);
  return match;
}
