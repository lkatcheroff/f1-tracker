# F1 Tracker: spec para desarrollo

> Brief para Claude Code. Objetivo: una webpage personal para seguir sesiones de F1 (gaps entre pilotos, tiempos, neumáticos, mapa) en **dos modos**, con **costo cero**.

## 1. Los dos modos

| Modo | Caso de uso | Fuente de datos (gratis) |
|---|---|---|
| **Replay** | Veo la carrera grabada (por ej. 1 h después de que terminó) y quiero el tracker sincronizado en paralelo | Archivo estático de F1 live timing (`/static/...jsonStream`). Fallback: OpenF1 histórico |
| **Live** | Sigo la sesión en vivo | Feed SignalR oficial de F1 (`livetiming.formula1.com`) vía relay propio |

**Decisión central de arquitectura:** los dos modos hablan **el mismo formato de mensajes** (el del feed de F1: `TimingData`, `TimingAppData`, `Position.z`, etc.). El archivo estático es el mismo stream que sale en vivo, pero grabado y con timestamps. Por eso:

- Hay **un solo parser/reducer de estado** para ambos modos.
- Todo el desarrollo y los tests se hacen contra sesiones pasadas (gratis y reproducibles), y el modo live es "solo" cambiar la fuente.

Por qué no OpenF1 como fuente principal: su live es pago (€9,90/mes). El histórico es gratis y se libera 30 min después del fin de la sesión, así que sirve como **fallback** del replay, pero tiene otro formato (REST normalizado) y requiere un adapter aparte.

## 2. Arquitectura

```
                ┌──────────────────────────── server (Node/TS) ────────────────────────────┐
F1 static  ───► │ ReplaySource  ─┐                                                         │
archive         │                ├─► RawMessage stream ─► StateEngine ─► Snapshot/Δ ─► WS ─┼─► web (React)
F1 SignalR ───► │ LiveSource    ─┘        │                                               │
                │                         └─► Recorder (.jsonl en disco)                   │
OpenF1 REST ──► │ OpenF1Source (fallback, adapter a RawMessage o directo a Snapshot)       │
                └──────────────────────────────────────────────────────────────────────────┘
```

- **Hace falta backend.** El browser no puede conectarse directo (CORS y el handshake de SignalR), así que el server hace de relay y re-emite por WebSocket propio.
- **El Recorder graba todo lo que entra en live.** Bonus: si el modo live funciona, una carrera grabada en vivo ya sirve para replay aunque el archivo oficial todavía no esté publicado.

### Interface común

```ts
type RawMessage = { topic: string; data: unknown; ts: number /* ms desde inicio de sesión o epoch */ };

interface DataSource {
  start(): AsyncIterable<RawMessage>;
  // solo Replay:
  seek?(ts: number): void;
  setSpeed?(x: number): void;
  pause?(): void; resume?(): void;
}
```

### StateEngine

- Mantiene el estado de la sesión aplicando **deep-merge** de los deltas (F1 manda un estado inicial completo y después solo diferencias parciales; los arrays a veces llegan como objetos con claves índice `{"0": {...}, "2": {...}}`).
- Emite al front un `Snapshot` tipado (no el JSON crudo de F1).
- Para soportar `seek` en replay: guardar **checkpoints** del estado cada ~30 s de sesión, así un seek reconstruye desde el checkpoint más cercano y no desde cero.

## 3. Fuentes, en detalle

### 3.1 Archivo estático (Replay)

- Base: `https://livetiming.formula1.com/static/`
- Índice por año: `/static/{year}/Index.json` (Meetings → Sessions → `Path`)
- Path de sesión, por ejemplo: `/static/2024/2024-09-08_Italian_Grand_Prix/2024-09-08_Race/`
- Archivos que usamos:
  - `TimingData.jsonStream`: posición, `GapToLeader`, `IntervalToPositionAhead`, last/best lap, sectores, pits
  - `TimingAppData.jsonStream`: stints (compuesto, vueltas del neumático)
  - `TimingStats.jsonStream`: personal bests, speed traps
  - `DriverList.jsonStream`: nombre, equipo, color
  - `LapCount.jsonStream`, `SessionStatus.jsonStream`, `TrackStatus.jsonStream`, `RaceControlMessages.jsonStream`, `WeatherData.jsonStream`
  - `Position.z.jsonStream`: X/Y/Z de cada auto (mapa)
  - `CarData.z.jsonStream`: telemetría (velocidad, rpm, marcha, throttle, freno)
- Formato `.jsonStream`: una línea por mensaje, con un timestamp `HH:MM:SS.mmm` (offset desde el inicio del stream) seguido del JSON.
- Formato `.z`: `base64` → `zlib` raw deflate (`inflateRaw` en Node). Adentro viene JSON con timestamps propios.
- Hay un mirror que mantiene FastF1: `https://livetiming-mirror.fastf1.dev`. Sirve como fallback si el oficial no responde.
- Leer el JSON con BOM-safe (`utf-8-sig`), porque algunos archivos lo traen.

### 3.2 SignalR (Live)

- Endpoint actual: `wss://livetiming.formula1.com/signalrcore` (SignalR Core). El legacy `https://livetiming.formula1.com/signalr` (hub `Streaming`, método `Subscribe`) puede seguir vivo o no: **verificar en el spike**.
- Topics a suscribir: `Heartbeat, DriverList, ExtrapolatedClock, RaceControlMessages, SessionInfo, SessionStatus, SessionData, TeamRadio, TimingAppData, TimingData, TimingStats, TrackStatus, WeatherData, Position.z, CarData.z, TopThree, LapCount`
- **Riesgo principal (restricción "todo gratis"):** F1 hoy autentica este feed con cuenta F1/F1 TV. Sin auth, según la doc de FastF1, "puede funcionar solo en algunas sesiones o devolver datos parciales". El modo live es **best-effort**: tiene que degradar con elegancia (mostrar qué topics llegan y cuáles no).
- Referencias para ver cómo lo resuelven otros: FastF1 (`fastf1.livetiming`, Python) y `f1-dash` (Rust + Next.js, AGPL-3.0; leer como referencia, **no copiar código** por la licencia).

### 3.3 OpenF1 (fallback del Replay)

- REST `https://api.openf1.org/v1/...`, histórico gratis desde 2023, disponible 30 min después del fin de sesión.
- Endpoints útiles: `sessions`, `drivers`, `laps`, `intervals` (solo carreras, cada ~4 s), `position`, `location` (~3,7 Hz), `car_data`, `stints`, `pit`, `race_control`, `weather`.
- Filtros: `session_key=latest`, `date>...`, `date<...`.
- Rate limit free: 3 req/s y 30 req/min. Hay que **cachear en disco** la sesión entera la primera vez, nunca pedirla por cada tick.

## 4. Sincronización con el video (feature clave del Replay)

El usuario mira la carrera grabada y pausa, adelanta o rebobina el video. El tracker tiene que seguirlo.

- **Reloj de reproducción** propio: `sessionTime = anchor + (now - wallAnchor) * speed`.
- **Botón "Sync: largada"**: el usuario lo aprieta cuando ve apagarse los semáforos en el video. El tracker alinea `sessionTime` con el inicio de la carrera (de `SessionStatus` → `Started`, o del primer `RaceControlMessages` de luz verde).
- **Ajuste fino**: botones ±1 s / ±5 s y un input de offset.
- Play/pausa y un **scrubber por vuelta** ("ir a vuelta 23").
- Atajos de teclado: espacio = play/pausa, ←/→ = ±5 s.
- Persistir offset y última posición en `localStorage` (por sesión) para retomar.
- **Modo spoiler-free:** no mostrar el resultado final ni nada "del futuro" respecto de `sessionTime` (el recap de la home y el título de la sesión no tienen que revelar al ganador).

## 5. UI (MVP)

1. **Timing tower**: Pos | # | Piloto (color de equipo) | Gap al líder | Intervalo | Última vuelta | Mejor vuelta | S1/S2/S3 (violeta = mejor absoluto, verde = PB, amarillo = resto) | Neumático + vueltas | Pits.
2. **Gráfico de gaps** en el tiempo: gap al líder por piloto, con selección de 2 a 4 pilotos para comparar.
3. **Mapa de pista** con `Position.z`: el trazado se arma con la posición de un auto en una vuelta limpia, y encima van los puntos animados de cada auto.
4. **Feed de Race Control** (banderas, SC/VSC, penalizaciones) + estado de pista y clima.
5. **Header**: vuelta N/M, estado de la sesión, modo (Replay/Live), controles de playback.

Fuera del MVP: telemetría comparada (`CarData.z`), team radio, predicción de pit window.

> Nota 2026: cambió el reglamento técnico (aero activa, ya no hay DRS). No asumir que los canales de `CarData` son iguales a los de años anteriores: **validar contra una sesión 2026** antes de mapearlos.

## 6. Stack propuesto

- Monorepo TypeScript (pnpm workspaces): `apps/server`, `apps/web`, `packages/core` (tipos + StateEngine, sin I/O).
- Server: Node 20+, Fastify + `ws`. Cliente SignalR: `@microsoft/signalr` (Core) o una implementación mínima si se usa el legacy.
- Web: Vite + React + TS. Charts: uPlot o Recharts. Mapa: SVG o canvas.
- Tests: Vitest. **Fixtures = una sesión real descargada a `fixtures/`** (por ejemplo un GP 2025 completo) y tests de snapshot del StateEngine en timestamps conocidos.

## 7. Plan de trabajo

**Fase 0: spikes (bloqueantes, antes de escribir producto)**
1. Bajar `Index.json` 2026 y una carrera completa. Medir **cuánto tarda en publicarse** el archivo después de la bandera a cuadros (¿alcanza para el caso "1 hora después"?). Si no alcanza, el plan B es OpenF1 (+30 min) o la grabación propia del modo live.
2. Script mínimo que se conecte a SignalR **sin auth** durante una sesión real (FP sirve) y loguee qué topics llegan con datos. Probar `signalrcore` y legacy.
3. Documentar los resultados en `docs/spikes.md`.

**Fase 1: core**
- Parser `.jsonStream` + decoder `.z` + StateEngine con deep-merge + checkpoints.
- Tests contra la fixture: posiciones y gaps en 3 o 4 momentos conocidos de la carrera.

**Fase 2: Replay end-to-end**
- ReplaySource con reloj, seek, velocidad y sync de largada.
- Server WS + timing tower + header de controles.

**Fase 3: visuales**
- Gráfico de gaps, mapa de pista, feed de Race Control.

**Fase 4: Live**
- LiveSource + Recorder + indicador de salud de topics. Reusa todo lo anterior.

**Fase 5: fallback OpenF1**
- `OpenF1Source` con cache en disco, para cuando el archivo estático no está.

## 8. Reglas para Claude Code

- No inventar estructuras de mensajes: **inspeccionar los datos reales** de la fixture antes de tipar. Si un campo no se pudo verificar, marcarlo `// UNVERIFIED`.
- `packages/core` es puro (sin red ni disco), así es testeable con fixtures.
- Ningún secreto ni credencial en el repo. Si en algún momento se agrega auth, va por `.env`.
- Uso personal: proyecto no oficial, sin afiliación con F1. No publicar con marcas ni logos de F1.
