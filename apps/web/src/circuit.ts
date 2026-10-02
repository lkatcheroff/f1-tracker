import { useEffect, useState } from "react";

export interface CircuitInfo {
  rotation: number;
  corners: { number: number; letter?: string; angle: number; trackPosition: { x: number; y: number } }[];
  marshalSectors: { number: number; trackPosition: { x: number; y: number } }[];
  /** segundos que cuesta una parada, estimados por MultiViewer */
  pitLoss?: { normal: string; sc: string; vsc: string };
}

const cache = new Map<string, Promise<CircuitInfo | null>>();

/**
 * Curvas, sectores de banderilleros y orientación del circuito, de la API pública de MultiViewer
 * (la misma que usan FastF1 y f1-dash). Es un extra: si no responde, el mapa se dibuja sin esas marcas.
 */
export function useCircuit(circuitKey: number | null | undefined, year: number | null | undefined): CircuitInfo | null {
  const [info, setInfo] = useState<CircuitInfo | null>(null);
  useEffect(() => {
    if (!circuitKey || !year) return setInfo(null);
    const key = `${circuitKey}/${year}`;
    if (!cache.has(key)) {
      cache.set(
        key,
        fetch(`https://api.multiviewer.app/api/v1/circuits/${key}`)
          .then((r) => (r.ok ? r.json() : null))
          .then((d) => (d && Array.isArray(d.corners) ? (d as CircuitInfo) : null))
          .catch(() => null),
      );
    }
    let stale = false;
    cache.get(key)!.then((d) => !stale && setInfo(d));
    return () => {
      stale = true;
    };
  }, [circuitKey, year]);
  return info;
}
