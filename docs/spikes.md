# Spikes de la Fase 0

Corridos el 2026-10-02 (viernes del GP de Bahrein en Kuala Lumpur, con FP1 y FP2 ya terminadas).

## 1. Cuánto tarda F1 en publicar el archivo estático

**Resultado: unos 30 a 35 minutos después del final de la sesión. Alcanza para el caso "1 hora después".**

Medido con el `Last-Modified` de los `.jsonStream` en `livetiming.formula1.com/static/`:

| Sesión | Fin de sesión (UTC) | Publicado (UTC) | Demora |
|---|---|---|---|
| Carrera de Azerbaiyán, 26/9 | bandera 12:41:55 | 13:15:28 | 34 min |
| Carrera de España, 13/9 | bandera ~14:35 (estimado por horario) | 15:07:13 | ~32 min |
| FP2 de Bahrein, 2/10 | 09:00 | 09:30:16 | 30 min |
| FP1 de Bahrein, 2/10 | ~05:30 (por horario) | 05:57:27 | ~27 min |

- La hora de bandera de Azerbaiyán sale del propio stream: `SessionStatus` pasa a `Finished` a las 02:34:55.607 y el stream arranca a las 10:06:59.5 UTC (de `Heartbeat`).
- Todos los archivos de una sesión se publican juntos, en el mismo segundo.
- Mientras la sesión no está publicada, `Index.json` del año la lista sin `Path`.
- Límite: `Last-Modified` es la fecha de la última subida. Si F1 resubiera archivos, mediría de más; las cuatro sesiones dan lo mismo, así que no parece el caso.

### Mirror de FastF1

`https://livetiming-mirror.fastf1.dev` responde 404 en todo (raíz, `Index.json`, sesiones 2024 y 2026). No se usa.

## 2. Feed en vivo sin autenticación

**Resultado: conecta y entrega timing completo, pero sin posiciones ni telemetría. Falta confirmarlo con una sesión en curso.**

Se reproduce con `npm run probe:live`.

| Prueba | Resultado |
|---|---|
| Legacy `https://livetiming.formula1.com/signalr/negotiate` | **HTTP 401** (`WWW-Authenticate: Basic`, `Bearer`). Descartado. |
| `POST https://livetiming.formula1.com/signalrcore/negotiate?negotiateVersion=1` | **HTTP 200** sin credenciales |
| WebSocket `wss://livetiming.formula1.com/signalrcore?id=<connectionToken>` | Abre. Necesita la cookie `AWSALB` del negotiate (afinidad del balanceador). |
| `Subscribe` con los 17 topics | Devuelve el estado inicial de 14 |

Topics con datos: `Heartbeat`, `DriverList`, `ExtrapolatedClock`, `RaceControlMessages`, `SessionInfo`, `SessionStatus`, `SessionData`, `TeamRadio`, `TimingAppData`, `TimingData`, `TimingStats`, `TrackStatus`, `WeatherData`, `TopThree`.

Topics ausentes: `Position.z`, `CarData.z` y `LapCount`. Este último es esperable: solo existe en carreras.

Consecuencia: el modo live sin cuenta tiene torre de tiempos, gaps, neumáticos, Race Control y clima, pero **no tiene mapa**. El replay del archivo estático sí trae `Position.z` y `CarData.z`.

### Lo que no se pudo verificar

La prueba se hizo con la pista cerrada, así que solo se vio el estado inicial. Quedan dos cosas marcadas `UNVERIFIED` en `apps/server/src/liveSource.ts`:

1. La forma de los mensajes incrementales (`target: "feed"`, `arguments: [topic, data, timestamp]`). Es la que documentan FastF1 y f1-dash.
2. Que `Position.z` y `CarData.z` sigan ausentes con autos en pista.

Para cerrarlo, correr `npm run probe:live` (o abrir el modo live) durante la próxima sesión y mirar el panel de topics.

## 3. Formato de los datos (inspección de la fixture 2026)

Fixture: carrera de Azerbaiyán 2026 (`npm run fixture`).

- **Deltas**: el primer mensaje de cada topic trae el estado completo; los siguientes, diferencias parciales. Los arrays (`Sectors`, `Stints`, `Messages`, `BestLapTimes`, `Stats`) se actualizan con objetos de claves índice.
- **Gaps**: `"+12.345"`, `"LAP 14"` (líder), `"1L"` / `"1 L"` (vueltas perdidas), `""`.
- **Clasificación**: no hay `GapToLeader`; las diferencias van en `Stats[parte]` con la clave `TimeDifftoPositionAhead` (con `t` minúscula). **Práctica**: `TimeDiffToFastest` y `TimeDiffToPositionAhead` en la línea.
- **`Position.z`**: lotes de 2 a 5 muestras (~5 Hz), cada una con `Timestamp` UTC y `Entries[nº] = {Status, X, Y, Z}` en décimas de metro. El lote llega ~1 s después de su última muestra.
- **Largada**: `SessionStatus` → `Started` a las 00:56:53.247 coincide con el mensaje `RACE START` de Race Control y con el primer movimiento de los autos en `Position.z` (dentro de 1 s). Es el ancla del botón "Sync: largada".
- **`CarData.z` 2026**: los autos traen los canales `0, 2, 3, 4, 5`. No aparece el canal `45` (DRS en años anteriores), consistente con el reglamento 2026. La telemetría está fuera del MVP y no se mapeó.

## 4. OpenF1 como fallback

- `api.openf1.org` responde sin clave para el histórico. La carrera de Azerbaiyán completa (22 autos) se baja en ~65 s con el rate limit gratuito: lo pesado es `location` (~3 MB por auto). Después queda en caché.
- Comparado con el feed oficial en la misma carrera: orden y gaps coinciden en la vuelta 14 y en la clasificación final.
- Diferencias de la reconstrucción: no hay retiros ni estado de sesión (se deduce de Race Control), el líder no muestra `LAP N`, y la edad de neumáticos puede diferir en algunas vueltas respecto del feed.

## 5. Hosting estático (GitHub Pages)

Probado el 2026-10-02 mandando el header `Origin` de un sitio de GitHub Pages:

| Recurso | ¿Lo puede leer el navegador desde otro sitio? |
|---|---|
| `livetiming.formula1.com/static/...` | No: responde sin `Access-Control-Allow-Origin` |
| `livetiming.formula1.com/signalrcore/negotiate` | No: ídem |
| `api.openf1.org` | Sí (`Access-Control-Allow-Origin: *`) |
| `api.multiviewer.app/api/v1/circuits/{circuito}/{año}` | Sí (`*`) |

Por eso el sitio estático no lee a F1 directo: una GitHub Action baja y procesa las sesiones, y el navegador las lee del propio sitio. El live queda fuera, porque necesita un proceso conectado al WebSocket de F1.

Otros datos que salieron de esta ronda:

- `Position.z` incluye las entradas `241`, `242` y `243` solo mientras hay Safety Car. La `241` es la que circula (el Safety Car); `242` y `243` figuraron siempre fuera de pista en la fixture, sin verificar qué son.
- Un auto que abandona en pista pasa a transmitir `X=0, Y=0`. El engine conserva su última posición real.
- `InPit` pasa a `true` en la entrada de boxes y a `false` en la salida: el recorrido de un auto entre ambos eventos dibuja la calle de boxes.
- `PitOut` dura solo ~40 s. La vuelta de salida completa se reconoce por los mini-sectores con estado `2064`. Otros estados: `2048` sin mejora, `2049` mejor personal, `2051` mejor absoluto.
- La API de MultiViewer devolvió para Bakú 2026 la vuelta de referencia de 2022 (mismo trazado). En un circuito modificado, las curvas podrían quedar corridas.
- La GitHub Action no se pudo ejecutar todavía (no hay repo). El script que corre (`scripts/mirror.ts`) y el sitio compilado sí se probaron en local, servidos desde una subruta.
