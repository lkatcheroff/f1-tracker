/**
 * Parámetros del análisis. Son puntos de partida calibrados con la carrera de Bakú 2026, no verdades de la F1:
 * cada uno dice para qué sirve y de dónde sale el valor. Todos se pueden pisar con `buildInsights(..., { params })`.
 */
export const PARAMS = {
  /**
   * Cuánto tiene que sostenerse un orden nuevo para contar como sobrepaso. Las posiciones parpadean en los cruces
   * de línea y de mini-sector: en Bakú hubo 7 rebotes que vuelven al orden anterior en menos de 4 s.
   * Los duelos de autos pegados que se cruzan cada 30 s son sobrepasos reales y no se filtran.
   */
  OVERTAKE_DEBOUNCE_MS: 4000,
  /**
   * Ventana alrededor de una entrada o salida de boxes en la que un cambio de posición se atribuye a la parada.
   * La calle de boxes de Bakú tarda ~21 s (entrada a salida) y el feed actualiza el orden al cruzar líneas de tiempo.
   */
  PIT_WINDOW_MS: 30_000,
  /** Cambios de posición de la vuelta 1 que se agrupan en el evento de largada. */
  START_WINDOW_MS: 90_000,
  /** Un rival entra en el análisis de undercut si está a menos de la pérdida de una parada más este margen. */
  PAIR_MARGIN_SEC: 3,
  /** Vueltas dentro de las cuales el rival tiene que parar para que haya undercut u overcut. */
  UNDERCUT_MAX_LAPS: 8,
  /** Vueltas que se esperan tras la salida de boxes del segundo para medir el resultado. */
  SETTLE_LAPS: 2,
  /** Una vuelta se descarta del ritmo si se aleja de la mediana del stint más este múltiplo de la MAD (tráfico, errores). */
  CLEAN_LAP_MAD_K: 3,
  /** Vueltas limpias mínimas para calcular la pendiente de un stint. */
  MIN_STINT_LAPS: 5,
  /** Intervalo (s) por debajo del cual dos autos se consideran en duelo. */
  BATTLE_GAP_SEC: 1.0,
  /** Intervalo (s) por encima del cual el duelo se da por terminado (durante `BATTLE_END_LAPS` vueltas). */
  BATTLE_END_GAP_SEC: 1.5,
  /** Vueltas seguidas dentro de `BATTLE_GAP_SEC` para declarar un duelo. */
  BATTLE_MIN_LAPS: 3,
  /** Vueltas seguidas fuera de `BATTLE_END_GAP_SEC` para cerrarlo. */
  BATTLE_END_LAPS: 2,
  /** Vueltas para el ritmo reciente de cada auto en la proyección. */
  PACE_WINDOW: 3,
  /** Cierre mínimo (s/vuelta) para proyectar que un auto alcanza a otro. */
  MIN_CLOSING: 0.2,
  /** Cuánto se espera tras el cierre de una vuelta para leer posición y gaps: el feed los actualiza unos instantes después. */
  LAP_SETTLE_MS: 2000,
  /** La vuelta rápida de una carrera se anuncia desde esta vuelta (la 1 sale desde parado y no cuenta). */
  FASTEST_LAP_FROM_LAP: 2,
  /** Tramos del mapa de dominio. */
  DOMINANCE_SEGMENTS: 25,
  /** Diferencia (ms) por debajo de la cual un tramo se pinta como empate. */
  DOMINANCE_TIE_MS: 30,
  /** Segundos de anticipo al saltar a un evento. */
  SEEK_LEAD_MS: 10_000,
} as const;

export type Params = { -readonly [K in keyof typeof PARAMS]: number };
