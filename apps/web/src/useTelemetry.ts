import type { SessionTelemetry } from "@f1/core";
import { useEffect, useState } from "react";
import { loadTelemetry } from "./transport";

export type TelemetryState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "missing" }
  | { status: "error"; message: string }
  | { status: "ready"; data: SessionTelemetry };

/** Baja la telemetría de `source` cuando se la pide (null = todavía no hace falta). */
export function useTelemetry(source: string | null): TelemetryState {
  const [state, setState] = useState<TelemetryState>({ status: "idle" });
  useEffect(() => {
    if (!source) return;
    let stale = false;
    setState({ status: "loading" });
    loadTelemetry(source)
      .then((data) => !stale && setState(data ? { status: "ready", data } : { status: "missing" }))
      .catch((e: Error) => !stale && setState({ status: "error", message: e.message }));
    return () => {
      stale = true;
    };
  }, [source]);
  return state;
}
