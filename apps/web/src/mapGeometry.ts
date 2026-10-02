type XY = [number, number];

/**
 * Pasa de coordenadas del feed a coordenadas de pantalla: rota el circuito como en el mapa oficial
 * (`rotation` en grados, la misma convención que usa FastF1) e invierte Y, que en SVG crece hacia abajo.
 */
export function projector(rotation: number): (x: number, y: number) => XY {
  const a = (rotation * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  return (x, y) => [x * cos - y * sin, -(x * sin + y * cos)];
}

const dist = (a: XY, b: XY) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** Índice del punto del trazado más cercano a `p`. */
export function nearestIndex(points: XY[], p: XY): number {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < points.length; i++) {
    const d = dist(points[i], p);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/** Vector unitario normal al trazado en el punto `i`, apuntando hacia afuera del circuito. */
export function outwardNormal(points: XY[], i: number, centroid: XY): XY {
  const n = points.length;
  const a = points[(i - 2 + n) % n];
  const b = points[(i + 2) % n];
  const len = dist(a, b) || 1;
  let nx = -(b[1] - a[1]) / len;
  let ny = (b[0] - a[0]) / len;
  const p = points[i];
  if ((p[0] + nx - centroid[0]) ** 2 + (p[1] + ny - centroid[1]) ** 2 < (p[0] - centroid[0]) ** 2 + (p[1] - centroid[1]) ** 2) {
    nx = -nx;
    ny = -ny;
  }
  return [nx, ny];
}

export function centroidOf(points: XY[]): XY {
  let x = 0;
  let y = 0;
  for (const p of points) {
    x += p[0];
    y += p[1];
  }
  return [x / points.length, y / points.length];
}

/**
 * Rectas largas del trazado, de mayor a menor: tramos donde la dirección casi no cambia.
 * El feed no publica zonas de sobrepaso; el final de una recta larga es donde suelen darse.
 * Devuelve índices `[desde, hasta]` sobre el trazado (puede dar la vuelta por el final).
 */
export function longStraights(points: XY[], max = 3): { from: number; to: number; length: number }[] {
  const n = points.length;
  if (n < 50) return [];
  const W = 4; // puntos hacia cada lado para medir el giro (~60 m)
  const straight = points.map((p, i) => {
    const a = points[(i - W + n) % n];
    const b = points[(i + W) % n];
    const h1 = Math.atan2(p[1] - a[1], p[0] - a[0]);
    const h2 = Math.atan2(b[1] - p[1], b[0] - p[0]);
    let turn = Math.abs(h2 - h1);
    if (turn > Math.PI) turn = 2 * Math.PI - turn;
    return turn < (5 * Math.PI) / 180;
  });
  if (straight.every(Boolean)) return [];

  let lap = 0;
  for (let i = 0; i < n; i++) lap += dist(points[i], points[(i + 1) % n]);

  // Se recorre desde un punto de curva para que la recta de meta, que cruza el final del array, salga entera.
  const start = straight.indexOf(false);
  const runs: { from: number; to: number; length: number }[] = [];
  let from = -1;
  let length = 0;
  for (let k = 1; k <= n; k++) {
    const i = (start + k) % n;
    if (straight[i]) {
      if (from === -1) {
        from = i;
        length = 0;
      } else length += dist(points[(i - 1 + n) % n], points[i]);
    } else if (from !== -1) {
      runs.push({ from, to: (i - 1 + n) % n, length });
      from = -1;
    }
  }
  return runs
    .filter((r) => r.length > Math.max(lap * 0.08, 4000))
    .sort((a, b) => b.length - a.length)
    .slice(0, max);
}

/** Puntos del trazado entre dos índices, dando la vuelta si hace falta. */
export function slicePoints(points: XY[], from: number, to: number): XY[] {
  return to >= from ? points.slice(from, to + 1) : [...points.slice(from), ...points.slice(0, to + 1)];
}
