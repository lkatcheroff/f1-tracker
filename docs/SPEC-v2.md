# F1 Tracker: SPEC v2

> Brief para Claude Code. Continúa `docs/SPEC.md` (v1, ya implementada: replay, live, sitio estático). Esta versión suma dos cosas:
> 1. **Funcionalidades para el fanático**: el tracker detecta y cuenta solo lo que pasa en la carrera.
> 2. **Credibilidad del proyecto**: tests que corren en CI, README que se vende solo, móvil, licencia y atribución.
>
> Todo sigue siendo gratis y sin servidor propio en producción (GitHub Pages + Action).

## 0. Estado actual (verificado en el repo, 2026-10-08)

- Monorepo npm workspaces: `packages/core` (puro, sin I/O), `packages/openf1`, `apps/server` (Fastify + WS), `apps/web` (Vite + React 19 + uPlot), `scripts/mirror.ts`.
- ~6.500 líneas de TS. Tests solo en `packages/core/test/engine.test.ts` (33 casos).
- **Tres bloques de tests con datos reales usan `describe.skipIf(!HAS_FIXTURE)`**, y la fixture (24 MB) está en `.gitignore`. En GitHub Actions se saltean.
- El sitio publicado sale del camino **OpenF1** (F1 le responde 403 a los runners de GitHub). El adaptador `packages/openf1`, el server y `mirror.ts` no tienen tests.
- `deploy` en `pages.yml` depende solo de `build`; el job `test` corre aparte.
- Ya existen: `Snapshot`/`DriverRow` (posición, gap, intervalo, neumático, `pits`, `inPit`, `retired`, `minis`, `catching`…), `SessionIndex` (`starts`, `laps`, `events` de pista y sesión), telemetría por vuelta (`TelemetryLap`, `timeAtFraction`, `sectorTimes`, `bestLap`, `completedLaps`), modo sin spoilers, costo de parada por circuito (MultiViewer).
- No hay LICENSE, lint/format, capturas ni GIF. Un solo breakpoint CSS (1080 px).

## 1. Principios (no negociables)

1. **Cero invención.** Antes de tipar o detectar algo, inspeccionar los datos reales (fixture local) y, si no se pudo verificar, marcar `// UNVERIFIED` y listarlo en `docs/spikes.md`.
2. **`packages/core` sigue puro.** Todo el análisis nuevo vive ahí (`packages/core/src/insights/`), sin red ni disco, y se testea con datos en memoria.
3. **Sin spoilers por construcción.** Ningún resultado puede mostrarse antes de su momento (ver §3.4). Es la ventaja de este tracker frente a cualquier otro; no se rompe.
4. **Honestidad de datos.** Lo estimado se rotula como estimado (`≈`). Con la fuente OpenF1 faltan cosas (ver §3.5); el análisis se degrada con elegancia, no inventa.
5. **Reglas, no IA.** Los análisis son determinísticos, con parámetros nombrados en un solo archivo y cubiertos por tests. Nada de llamadas a LLM en runtime.
6. **Mismo código para los tres orígenes** (archivo oficial, OpenF1, grabación propia). El análisis consume mensajes/estado, nunca una fuente específica.

## 2. Decisiones abiertas (Lucas confirma; si no responde, rige el valor por defecto)

| # | Decisión | Por defecto |
|---|---|---|
| D1 | Licencia | MIT |
| D2 | Lint/format | Biome (una sola herramienta) |
| D3 | Fixture para CI | **Sintética** (ver §4.1). Un recorte real del feed oficial solo se commitea si Lucas revisó los términos de uso de los datos |
| D4 | Dónde se calculan los insights | En el cliente (Web Worker) al cargar la sesión. Si pasa los presupuestos de §3.7 no hace falta tocar el pack ni regenerar sesiones |
| D5 | Segundos de "anticipo" al saltar a un evento | 10 s |
| D6 | Idioma de la UI | Español. Plantillas del resumen separadas por idioma, para sumar inglés después |

## 3. Funcionalidades nuevas

Ordenadas por valor para el fanático. Cada una tiene criterios de aceptación.

### 3.0 Base común: tabla de vueltas (`LapTable`)

Todas las funciones salen de una tabla `vuelta × piloto` que se arma **una sola vez** recorriendo la sesión con el `StateEngine`.

```ts
export interface LapRow {
  driver: string;                 // nº de auto
  lap: number;
  endTs: number;                  // ms de sesión en que se completó (mismo eje que RawMessage.ts)
  lapTimeMs: number | null;
  position: number;               // al cierre de la vuelta
  gapLeaderSec: number | null;    // null si va a una o más vueltas
  intervalSec: number | null;
  tyre: { compound: string; age: number; isNew: boolean } | null;
  inLap: boolean;                 // entró a boxes en esta vuelta
  outLap: boolean;                // salió de boxes en esta vuelta
  neutralized: boolean;           // SC / VSC / bandera roja durante la vuelta
  yellow: boolean;                // bandera amarilla en algún sector durante la vuelta
  sectorsMs: [number | null, number | null, number | null];
}
export interface Stint { driver: string; index: number; compound: string; lapStart: number; lapEnd: number; rows: LapRow[] }
export interface SessionInsights {
  laps: LapRow[];
  stints: Stint[];
  events: InsightEvent[];         // ordenados por ts
  dataQuality: DataQuality;
}
export interface DataQuality {
  source: "official" | "openf1" | "recording";
  hasPositions: boolean;
  hasTelemetry: boolean;
  approximations: string[];       // p. ej. "abandonos deducidos", "sin Safety Car en el mapa"
}
```

- Construcción: `buildInsights(messages: RawMessage[], opts): SessionInsights` en `packages/core/src/insights/`. Archivos sugeridos: `laps.ts`, `events.ts`, `strategy.ts`, `pace.ts`, `narrative.ts`, `ideal.ts`, `dominance.ts`, `params.ts`, `index.ts`.
- **Verificar primero (UNVERIFIED hasta inspeccionar):** cómo engancharse al `StateEngine` para detectar cierres de vuelta y cambios de posición **por mensaje**, sin muestrear cada X ms y sin romper su API pública. Si hace falta un hook, agregarlo de forma aditiva.
- Los sectores por vuelta salen de `TimingData` (`Sectors[n].Value`). Verificar en la fixture que el historial por vuelta se puede reconstruir; si no, derivarlo de los cambios de estado.
- Todos los umbrales viven en `params.ts` con nombre y comentario (ver §3.6).

### 3.1 Línea de eventos sobre la barra de avance (prioridad 1)

**Qué es:** marcas clickeables en el scrubber más un panel "Eventos" con la lista. Al hacer clic, el replay salta `D5` segundos antes del evento y sigue reproduciendo.

```ts
export type EventKind =
  | "start"          // resumen de la largada (posiciones ganadas/perdidas vs. grilla)
  | "overtake"       // sobrepaso en pista
  | "leadChange"
  | "pit"            // parada completa (entrada, salida, tiempo en calle de boxes)
  | "fastestLap"
  | "retirement"
  | "penalty"        // sanción anunciada por Race Control
  | "investigation"  // "UNDER INVESTIGATION" / "INCIDENT NOTED"
  | "neutralization" // SC, VSC, bandera roja (reusa SessionIndex.events)
  | "battle"         // duelo (ver §3.5)
  | "undercut" | "overcut"; // ver §3.3

export interface InsightEvent {
  id: string;                 // estable: `${kind}:${ts}:${drivers.join("-")}`
  kind: EventKind;
  ts: number;                 // momento en que el evento queda RESUELTO (compuerta de spoilers)
  seekTs: number;             // adonde salta el clic (<= ts); p. ej. el inicio de la maniobra
  lap: number | null;
  drivers: string[];          // protagonista primero
  data: Record<string, number | string | boolean | null>;
  confidence: "high" | "approx";
}
```

**Detección de sobrepasos (el más delicado).** Enganchado a los cambios de `position` por mensaje; cuando X pasa a estar delante de Y:

1. **Antirrebote:** el orden X-delante-de-Y debe sostenerse `OVERTAKE_DEBOUNCE_MS`. Las posiciones parpadean en los cruces de línea y de mini-sector.
2. **Clasificar** el cambio (cada cambio cae en exactamente una clase):
   - `pitCycle`: Y entró a boxes o salió de ellos dentro de `PIT_WINDOW_MS`, o X salió de boxes delante de Y. No es sobrepaso (alimenta §3.3).
   - `retirement`: Y está `retired`/`stopped`.
   - `start`: ocurre en la vuelta 1, antes de `START_WINDOW_MS`. Se agrupa en **un** evento `start` ("ganó N posiciones"), no en N sobrepasos.
   - `neutralized`: bajo SC/VSC/bandera roja. Se guarda pero se oculta por defecto.
   - `penalty`: reordenamiento por sanción (ligado a un mensaje de Race Control).
   - `onTrack`: el resto. **Solo esta clase es `overtake`.**
3. Un auto que pasa a dos en una maniobra genera dos eventos.
4. Se ignora todo cambio posterior a la bandera a cuadros.
5. **Invariante testeable:** para cada piloto, `posición de grilla − posición final` = suma de los cambios clasificados (todas las clases). Si no cuadra, el detector pierde o duplica cambios.
6. Con fuente OpenF1 (posiciones menos frecuentes) los sobrepasos salen con `confidence: "approx"`.

**Otros eventos:**
- `leadChange`: cambio del P1 que no sea `pitCycle`. Los que son `pitCycle` se informan como "toma la punta tras las paradas".
- `pit`: `InPit` true→false; guardar vuelta de entrada, tiempo en la calle de boxes y compuesto nuevo.
- `fastestLap`: cuando un `lastLap` llega con `ob` (mejor absoluto). Se emite solo si mejora al titular anterior.
- `retirement`: `retired` pasa a true. Con OpenF1 es deducido: `approx`.
- `penalty` / `investigation`: se parsean de `RaceControlMessages`. **UNVERIFIED:** formato exacto de los mensajes (p. ej. `"5 SECOND TIME PENALTY FOR CAR 44 (HAM)"`); inspeccionar la fixture y fijar las expresiones regulares con tests.
- `neutralization`: se reusan los eventos de pista y sesión de `SessionIndex.events`, con el mismo formato de salida.

**UI**
- Marcas en el scrubber con **forma + color** (no solo color): sobrepaso ▲, parada ■, SC/VSC franja, vuelta rápida ★ violeta, retiro ✕, sanción ⚑.
- Filtros por tipo (chips, recordados en `localStorage` con `try/catch`). Por defecto: sobrepasos, paradas, neutralizaciones, vuelta rápida, retiros, sanciones.
- Panel "Eventos": lista cronológica inversa (lo último arriba), un clic = salto. Los eventos `approx` llevan "≈".
- Teclado: `J` / `K` = evento anterior / siguiente (los atajos actuales —espacio, ←, →— no cambian).
- Con "Sin spoilers" la barra sigue yendo por vuelta (hoy ya lo hace); las marcas respetan §3.4.

**Aceptación**
- En la fixture de Bakú, el invariante del punto 5 se cumple para los 22 pilotos.
- Ningún cambio de posición queda sin clase.
- Un sobrepaso real y conocido de la carrera aparece (Lucas elige 2 o 3 y los fija como casos en el test local).
- Hacer clic en una marca lleva al tracker `D5` s antes y el tracker queda en reproducción.
- Funciona igual con las tres fuentes (con "≈" en OpenF1).

### 3.2 Resumen de carrera que se escribe solo (prioridad 2)

Texto generado con **plantillas determinísticas** a partir de los eventos. Sin IA.

- `narrative.ts` expone `describe(event, ctx, locale): string`. Plantillas en `narrative/es.ts` (inglés queda para después, D6).
- Ejemplos de salida (el tono es sobrio, de cronista):
  - `V22 · Pérez pasa a Gasly en la curva 4.` (la curva sale de la proyección sobre el trazado si hay posición; si no, se omite)
  - `V24 · Gasly para y sale 3,1 s detrás de Pérez, con duros nuevos.`
  - `V31 · Undercut de Norris sobre Piastri: gana 1,8 s con la parada.`
  - `V40 · Safety Car.`
  - `V52 · Vuelta rápida de Leclerc: 1:43.021.`
- Dos vistas:
  - **Crónica**: lista de frases por vuelta, la más reciente arriba. Es el mismo panel de eventos con texto en lugar de iconos (alternable).
  - **Estado de carrera**: tarjeta con líder, diferencia con el 2.º, quién está en boxes, estado de pista y los últimos 3 eventos.
- Botón "Copiar" de la crónica hasta el momento actual (útil para pegar en un chat con amigos). Opcional.
- Las plantillas reciben datos ya formateados (tiempos, nombres cortos); no hay lógica de negocio dentro del texto.

**Aceptación**
- Test de snapshot sobre un escenario sintético con una frase por tipo de evento.
- Ningún texto menciona un hecho posterior al `ts` actual (test dedicado, §3.4).
- El resumen no revela el resultado final mientras la sesión no terminó.

### 3.3 Undercut y overcut (prioridad 3)

Para cada parada se compara el orden **antes** y **después** del ciclo de paradas del rival directo.

Sea X el primero de un par en parar y Y el segundo.

- **Par candidato:** Y va inmediatamente delante de X al entrar X a boxes (misma vuelta de carrera, ninguno doblado) y `intervalSec ≤ pitLossSec + PAIR_MARGIN_SEC`. El costo de parada sale del dato por circuito que ya se usa (MultiViewer); si falta, estimarlo con `inLap + outLap − 2 × ritmo limpio` y rotularlo `≈`.
- **Ventana:** Y debe parar dentro de `UNDERCUT_MAX_LAPS` vueltas de X; si no, no hay evento.
- **Antes:** quién iba delante al cierre de la vuelta anterior a la entrada de X.
- **Después:** quién va delante al cierre de la vuelta de salida de Y más `SETTLE_LAPS`.
- **Se descarta** el par si hubo vuelta neutralizada entre las dos paradas, si alguno se retira, o si falta la diferencia en segundos.

| Antes | Después | Resultado |
|---|---|---|
| Y delante | X delante | **Undercut** exitoso de X |
| Y delante | Y delante | Undercut fallido de X |
| X delante | Y delante | **Overcut** exitoso de Y |
| X delante | X delante | Sin evento |

- `data` incluye `gainSec = (gapY − gapX)antes − (gapY − gapX)después`, vueltas de diferencia entre paradas y compuestos.
- `ts` = cierre de la vuelta de resolución (compuerta de spoilers). `seekTs` = entrada a boxes de X.
- Solo aplica a **carrera**. En práctica y clasificación el panel no aparece.

**Aceptación:** escenarios sintéticos para cada fila de la tabla más los descartes (SC en el medio, retiro, doblado). Test de que `ts` es posterior a ambas paradas.

### 3.4 Sin spoilers: compuerta única

Una sola función en `core` decide qué es visible:

```ts
export function visible<T extends { ts: number }>(items: T[], now: number): T[]
```

- Todo lo derivado (eventos, crónica, stints, proyecciones, vuelta ideal) pasa por ella con el `ts` de resolución, nunca con `seekTs`.
- **Marcas en el scrubber con "Sin spoilers" activo:** solo hasta el *punto más lejano ya visto* (`highWater`, persistido por sesión). Mostrar marcas más adelante revelaría cuándo pasan cosas. Con el modo apagado se muestran todas. Botón "Reiniciar" para borrar `highWater`.
- Los títulos y el listado de sesiones siguen sin mostrar resultados (ya es así).
- **Test obligatorio:** para N instantes de la fixture sintética, ninguna salida contiene información con `ts > now`.

### 3.5 Ritmo, duelos y proyección

**Evolución del ritmo por stint (neumáticos).**
- Entrada: `Stint`s de `LapTable`. Se usan solo vueltas **limpias**: sin `inLap`/`outLap`, sin `neutralized`/`yellow`, no la vuelta 1, y descartando las que superan `mediana del stint + CLEAN_LAP_MAD_K × MAD` (tráfico, errores).
- Mínimo `MIN_STINT_LAPS` vueltas limpias para mostrar pendiente. Regresión lineal tiempo vs. edad del neumático: pendiente en s/vuelta, `n` y R².
- Gráfico: eje X = edad del neumático, eje Y = tiempo relativo a la primera vuelta limpia del stint, una línea por stint, marcador por compuesto. Tabla al lado: piloto, stint, compuesto, vueltas, pendiente.
- **Rótulo obligatorio:** "Tendencia de ritmo (incluye el efecto de la carga de combustible, que no se corrige)". No llamarlo "degradación".
- Solo hasta el momento actual (vueltas con `endTs ≤ now`).

**Duelos (`battle`).**
- Un par ordenado (A delante, D detrás) con `intervalSec ≤ BATTLE_GAP_SEC` en `BATTLE_MIN_LAPS` cierres de vuelta consecutivos, ambos en pista y sin neutralización.
- Termina cuando el intervalo supera `BATTLE_END_GAP_SEC` durante 2 vueltas, o cuando cambia el orden (resultado: "pasó" / "aguantó").
- Se muestran los duelos activos en una tarjeta sobre la torre y como eventos en la línea de tiempo. Se puede reusar el flag `catching` del feed como pista, no como definición.

**Proyección "lo alcanza en N vueltas".**
- Para cada piloto D con un auto A delante: `ritmo_A` y `ritmo_D` = media de las últimas `PACE_WINDOW` vueltas limpias de cada uno. `cierre = ritmo_A − ritmo_D` (s/vuelta; positivo = D es más rápido).
- Si `cierre ≥ MIN_CLOSING` y no hay paradas ni neutralizaciones en la ventana: `vueltasParaAlcanzar = (intervalSec − BATTLE_GAP_SEC) / cierre`. Se muestra solo si `≤ vueltas restantes`.
- Rótulo en pantalla: "Proyección lineal. No considera tráfico, paradas ni neutralizaciones."

**Aceptación:** tests sintéticos con pendiente conocida (el valor recuperado coincide con el sembrado dentro de una tolerancia), exclusión de vueltas sucias, y que la proyección desaparece cuando hay una parada en la ventana.

### 3.6 Parámetros (todos en `insights/params.ts`)

| Nombre | Para qué | Valor inicial (a calibrar con la fixture) |
|---|---|---|
| `OVERTAKE_DEBOUNCE_MS` | sostener el orden nuevo | 4000 |
| `PIT_WINDOW_MS` | cambio de posición atribuible a boxes | 30000 |
| `START_WINDOW_MS` | agrupar la largada | 90000 |
| `PAIR_MARGIN_SEC` | rival "relevante" para undercut | 3 |
| `UNDERCUT_MAX_LAPS` | ventana de respuesta del rival | 8 |
| `SETTLE_LAPS` | vueltas para asentar tras la salida | 2 |
| `CLEAN_LAP_MAD_K` | descarte de vueltas atípicas | 3 |
| `MIN_STINT_LAPS` | vueltas limpias mínimas para pendiente | 5 |
| `BATTLE_GAP_SEC` / `BATTLE_END_GAP_SEC` | umbral de duelo / fin | 1.0 / 1.5 |
| `BATTLE_MIN_LAPS` | vueltas seguidas para declarar duelo | 3 |
| `PACE_WINDOW` | vueltas para el ritmo reciente | 3 |
| `MIN_CLOSING` | cierre mínimo para proyectar | 0.2 |

Son puntos de partida, no verdades: Claude Code los ajusta mirando la fixture y deja el criterio escrito en un comentario junto a cada uno. No se afirma que un valor sea "el correcto de F1".

### 3.7 Presupuestos

- `buildInsights` sobre una carrera completa: **< 500 ms** en un portátil de gama media y **< 1,5 s** en un celular de gama media, dentro del Web Worker (no bloquea la UI). Si no se cumple, se mueve al `mirror` y se sube `PACK_VERSION` (se regeneran las sesiones; ya existe el mecanismo de "mantener la versión anterior hasta regenerar").
- Memoria: la `LapTable` de una carrera (~22 × 60 filas) es chica; no guardar snapshots completos por vuelta.
- Peso del bundle: sin dependencias nuevas de más de ~20 kB gzip.

### 3.8 Visuales de mapa y clasificación

**Mapa de dominio por tramos (prioridad 4).**
- Con la telemetría por vuelta que ya existe (`TelemetryLap`, `timeAtFraction`): dividir la vuelta en `DOMINANCE_SEGMENTS` tramos (≈25) por fracción de distancia; para cada tramo, quién tardó menos entre los pilotos elegidos usando la **mejor vuelta de cada uno hasta el momento actual** (`bestLap`, `completedLaps`).
- Pintar el trazado por tramo con el color del ganador. Selección por defecto: los 2 primeros de la torre; el usuario elige hasta 4 (se reusa la selección del gráfico de gaps).
- Tramos con diferencia menor a `DOMINANCE_TIE_MS` se pintan neutros ("empate"). Tooltip/tap: diferencia en ms por tramo.
- **Aviso de límites:** la traza se alinea por posición y se escala al tiempo oficial (ya documentado en `docs/spikes.md`); la precisión por tramo es aproximada. Rotularlo.
- No disponible sin telemetría (live sin cuenta, o sesiones abiertas directo desde OpenF1 en el navegador): el panel se oculta con un mensaje claro.
- Los colores no pueden ser el único canal cuando dos pilotos son del mismo equipo: usar trazo sólido vs. punteado o un tono alternativo.

**Vuelta ideal (clasificación y práctica) (prioridad 5).**
- Por piloto: suma de sus mejores S1 + S2 + S3 de la sesión hasta `now`, contra su mejor vuelta real. Columna "Dejó en la mesa" = real − ideal, y qué sector limita.
- Los tiempos de sector salen de `LapRow.sectorsMs`. Aclarar en pantalla que incluye sectores de vueltas que pueden haber sido anuladas.
- Aceptación: test sintético con tres vueltas donde el ideal combina sectores de vueltas distintas.

**Velocidades máximas (opcional, prioridad 6).**
- Ranking de velocidad en trampa. **UNVERIFIED:** si el feed trae `Speeds` (I1, I2, FL, ST) por vuelta en `TimingData`. OpenF1 sí tiene `i1_speed`, `i2_speed`, `st_speed` por vuelta. Verificar la disponibilidad en cada fuente antes de construir; si falta en el archivo oficial, usar el máximo de `CarData` por vuelta.

**Fuera de alcance de v2:** frenadas por curva, team radio (el archivo estático no lo trae), campeonato, predicciones de resultado, cualquier detector que dependa de DRS (el reglamento 2026 no lo tiene).

## 4. Calidad y CI

### 4.1 Fixtures y tests que corren siempre (prioridad 0, antes de las funciones)

- **Constructor de escenarios sintéticos** `packages/core/test/builders.ts`: genera `RawMessage[]` con la **forma real** de los mensajes (verificada contra la fixture local) pero con pilotos y tiempos inventados (`AAA`, `BBB`…). Permite escribir escenarios mínimos: un sobrepaso en pista, una parada con undercut, un SC, un retiro, un doblado.
- Con eso se testean `LapTable`, detectores, estrategia, ritmo, narrativa y compuerta de spoilers **sin depender de datos reales** y sin redistribuir datos del feed.
- Los bloques `describe.skipIf(!HAS_FIXTURE)` se mantienen para la validación contra la carrera real **en local**, y el log de CI debe decir explícitamente cuántos se saltearon.
- *(Opcional, solo si D3 lo habilita)* `fixtures/mini/`: recorte real (≤ 1,5 MB) con excepción en `.gitignore`, generado por `npm run fixture:mini` desde la fixture completa. Documentar qué ventanas contiene.
- **Meta:** en CI, 0 tests de `core` saltados salvo los explícitamente marcados "requiere datos reales".

### 4.2 Cobertura de lo publicado

- `packages/openf1`: tests con respuestas HTTP **grabadas y mínimas** (inyectar `fetch`), incluyendo el caso `422 "demasiados datos"` (reintento y partición de rango), la vuelta de formación (bug ya corregido: caso de regresión), y el campo `date` de `pit` como instante de salida.
- `scripts/mirror.ts`: con `fetch` inyectado, verificar que (a) una segunda corrida sin novedades devuelve `changed=false`, (b) respeta `MIRROR_MAX_NEW_PER_RUN`, (c) mantiene la versión anterior si falla la regeneración.
- `apps/server`: prueba de humo del protocolo WS (cargar una sesión sintética, `seek`, `play`, recibir snapshots).
- Test de contrato para `DataQuality`: cada fuente declara sus aproximaciones.

### 4.3 Pipeline

- `deploy` pasa a depender de `test` en eventos `push` (el `schedule` sigue sin correr tests pesados, pero sí `typecheck`).
- Agregar lint/format (D2) a `npm run check` = `typecheck + lint + test`, y ese comando es el que corre el job.
- Documentar en el README qué hace cada job.

## 5. Experiencia móvil

Hoy hay un solo breakpoint (1080 px). LinkedIn se abre mucho desde el celular.

- Breakpoints: 1080 (existe), 720 y 480.
- En ≤ 720 px: una columna; controles compactos (play/pausa, barra y "Sync: largada"; el resto en un panel "Ajustes" plegable); **pestañas** para los paneles: Torre · Mapa · Gaps · Eventos · Telemetría.
- Torre en móvil: mostrar Pos, piloto, gap/intervalo y neumático; sectores y mini-sectores detrás de un selector de columnas o con scroll horizontal **interno** de la tabla (no de la página).
- Nada que dependa de `hover`: la información del mapa y de los gráficos se obtiene también con toque.
- Objetivos táctiles ≥ 44 px.
- **Aceptación (automatizable con Playwright):** a 390×844, `document.scrollWidth <= window.innerWidth`, y se puede sincronizar la largada, cambiar de pestaña y hacer clic en un evento.

## 6. Documentación y portfolio

- **README** reestructurado: imagen/GIF arriba → resumen de 3 líneas **en español e inglés** → link a la demo (`https://lkatcheroff.github.io/f1-tracker/`) → "Qué hace" con capturas → "Cómo está hecho" (diagrama simple: mismo `StateEngine` para replay y live, Web Worker, Action que publica) y las decisiones clave (spikes medidos, por qué OpenF1 en el sitio) → "Datos y límites" → desarrollo, tests, créditos.
- `docs/DATA_SOURCES.md`: qué fuente se usa para qué (feed de F1, OpenF1, API de MultiViewer), qué falta con cada una (ver README actual) y **enlaces a los términos de cada servicio**. Lucas verifica las condiciones de uso antes de dar por cerrado el punto; Claude Code no afirma permisos que no pudo comprobar.
- **Atribución visible** en el pie del sitio: OpenF1, MultiViewer y "Proyecto personal no oficial, sin afiliación con Formula 1" (esto último ya existe).
- **Aviso de calidad por sesión** cuando `dataQuality.source === "openf1"`: una línea corta ("Datos de OpenF1: sin Safety Car en el mapa; abandonos y estado de pista aproximados"), con el detalle en un tooltip o enlace.
- `LICENSE` (D1), `.editorconfig`/config de Biome (D2).
- Sacar `.claude/launch.json` del repo (o dejarlo si Lucas lo usa a propósito).
- **Script de capturas** `npm run screenshots` (Playwright, corre en local contra `vite preview` con los datos de `data/`): genera `docs/img/` en escritorio y móvil, y opcionalmente video de la sesión de replay para convertir en GIF. No corre en CI.

## 7. Plan de trabajo

Una fase = una serie de commits chicos, cada uno con `npm run check` en verde.

| Fase | Contenido | Resultado |
|---|---|---|
| **A. Cimientos** | §4.1 builders y escenarios sintéticos; §4.3 pipeline; lint/format; LICENSE | CI honesto: lo que pasa en verde se ejecutó |
| **B. Núcleo de análisis** | §3.0 `LapTable` + §3.4 compuerta + §3.1 detectores | `buildInsights` testeado, sin UI |
| **C. Eventos en pantalla** | §3.1 UI (marcas, panel, `J`/`K`, filtros) | Funcionalidad estrella usable |
| **D. Crónica** | §3.2 plantillas + tarjeta "Estado de carrera" | La carrera se cuenta sola |
| **E. Estrategia y ritmo** | §3.3 undercut/overcut, §3.5 ritmo, duelos, proyección | Análisis de estrategia |
| **F. Visuales** | §3.8 dominio por tramos, vuelta ideal, (velocidades) | Mapa y clasificación más ricos |
| **G. Cobertura de lo publicado** | §4.2 tests de OpenF1, mirror y server | El camino que alimenta el sitio queda cubierto |
| **H. Móvil y portfolio** | §5, §6; capturas y GIFs al final, con la UI definitiva | Repo listo para mostrar |

## 8. Definición de terminado (global)

- `npm run check` verde en local y en CI, con el conteo de tests saltados visible.
- Todas las funciones nuevas respetan la compuerta de spoilers (test dedicado).
- Presupuestos de §3.7 medidos y anotados en `docs/spikes.md`.
- Todo lo que no se pudo verificar sigue marcado `UNVERIFIED` y listado en `docs/spikes.md`.
- Sin dependencias ni credenciales nuevas; nada de datos reales del feed commiteado salvo decisión explícita (D3).
- Deploy a Pages funcionando con las sesiones existentes, sin regenerarlas (o, si se regeneran, conservando la versión anterior hasta terminar).

## 9. Prompt para arrancar con Claude Code

> Leé `docs/SPEC.md`, `docs/spikes.md` y `docs/SPEC-v2.md`. Empezá por la **Fase A**. Antes de escribir código, inspeccioná `packages/core/src/engine.ts` y la fixture local y contame (1) cómo se puede detectar el cierre de una vuelta y un cambio de posición por mensaje, y (2) qué forma real tienen los mensajes de `TimingData`, `TimingAppData` y `RaceControlMessages` que necesita el constructor de escenarios. Proponé el diseño de `builders.ts` y esperá mi OK antes de implementarlo. Marcá `UNVERIFIED` todo lo que no puedas comprobar.

## 10. Material para el post (LinkedIn)

Cuando la UI esté definitiva (Fase H), grabar tres clips cortos de 10 a 15 s:

1. Clic en una marca de sobrepaso: el tracker salta al momento y se ve la torre cambiar.
2. La crónica llenándose sola mientras avanza el replay.
3. El mapa de dominio por tramos comparando dos pilotos.

Con un clip y una frase concreta ("detecta undercuts y los cuenta solo") el post pasa de "armé una web" a "armé un analizador de carreras".
