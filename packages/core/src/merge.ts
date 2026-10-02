type Json = unknown;

const isObject = (v: Json): v is Record<string, Json> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Deep-merge de un delta del feed sobre el estado.
 * F1 manda el estado inicial completo y después diferencias parciales. Los arrays del estado
 * inicial se actualizan con objetos de claves índice (`{"0": {...}, "2": {...}}`).
 * Devuelve el nuevo valor; muta `target` cuando es objeto o array.
 */
export function deepMerge(target: Json, patch: Json): Json {
  if (Array.isArray(patch)) return patch.map((v) => deepMerge(undefined, v));
  if (!isObject(patch)) return patch;

  if (Array.isArray(target)) {
    for (const [k, v] of Object.entries(patch)) {
      const i = Number(k);
      if (Number.isInteger(i) && i >= 0) target[i] = deepMerge(target[i], v);
    }
    return target;
  }
  const out: Record<string, Json> = isObject(target) ? target : {};
  for (const [k, v] of Object.entries(patch)) out[k] = deepMerge(out[k], v);
  return out;
}

/** Lista a partir de un array o de un objeto con claves índice (según cómo haya llegado). */
export function asList<T>(v: unknown): T[] {
  if (Array.isArray(v)) return v as T[];
  if (isObject(v)) {
    return Object.keys(v)
      .filter((k) => /^\d+$/.test(k))
      .sort((a, b) => +a - +b)
      .map((k) => v[k] as T);
  }
  return [];
}
