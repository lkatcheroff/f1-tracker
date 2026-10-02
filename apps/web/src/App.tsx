import { useEffect, useState } from "react";
import { Home } from "./Home";
import { SessionView } from "./SessionView";
import { store } from "./format";
import { STATIC, type Target } from "./transport";

function parseHash(): Target | null {
  const h = location.hash.replace(/^#\/?/, "");
  if (h === "live") return STATIC ? null : { mode: "live" };
  if (h.startsWith("replay/")) {
    // `?t=<segundos>` abre en ese punto de la sesión; si no, donde se dejó la última vez.
    const [ref, query] = h.slice("replay/".length).split("?");
    const source = decodeURIComponent(ref);
    const t = Number(new URLSearchParams(query ?? "").get("t"));
    return { mode: "replay", source, at: t > 0 ? t * 1000 : store.get<{ time?: number }>(`f1t:pos:${source}`, {}).time };
  }
  return null;
}

export function App() {
  const [target, setTarget] = useState(parseHash);
  useEffect(() => {
    const onHash = () => setTarget(parseHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  return target ? <SessionView key={target.mode === "live" ? "live" : target.source} target={target} /> : <Home />;
}
