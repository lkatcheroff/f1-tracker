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

## 6. Telemetría

- `CarData.z` (2026): canales `0` rpm, `2` velocidad, `3` marcha, `4` acelerador (0 a 104, se recorta a 100) y `5` freno (0 o 100+). Sin canal `45` (DRS). Unas 4 muestras por segundo por auto. Los mismos canales llegan por `car_data` de OpenF1 (`rpm`, `speed`, `n_gear`, `throttle`, `brake`).
- Las muestras de `Position.z` y `CarData.z` tienen reloj propio (`Timestamp` / `Utc`) y llegan en lotes con ~1 s de demora; para alinear telemetría con posiciones vale el reloj de la muestra, no el de llegada del lote.
- Los tiempos de vuelta y sector oficiales no sirven para ubicar la meta con precisión de ms (el mensaje de cronometraje sale algo después del cruce): la traza se alinea por posición y se escala para que el tiempo total sea el oficial.
- **Bug encontrado y corregido:** con OpenF1, que sí trae la vuelta de formación, el trazado se armaba con dos vueltas (11,9 km en Bakú) y la meta quedaba en la grilla. Ahora se rechaza un recorrido que pasa por la meta a mitad de camino.
- OpenF1 respondió una vez `422 "demasiados datos de una vez"` a un pedido de `location` que otras veces acepta; se reintenta y, si insiste, se parte el rango en dos.
- Cada sesión con telemetría son ~55 pedidos a OpenF1 (límite: 30 por minuto).

### F1 bloquea a los servidores de GitHub

Medido desde un runner de GitHub Actions (IP de Azure en EE. UU.) con un workflow de diagnóstico:

| Pedido desde el runner | Respuesta |
|---|---|
| `livetiming.formula1.com/static/2026/Index.json` | **403** de CloudFront, con cualquier `User-Agent` |
| `livetiming.formula1.com/signalrcore/negotiate` | **403** |
| `api.openf1.org` | 200 |
| `api.multiviewer.app` | 200 |

El bloqueo es por IP (o por región), no por cómo se identifica el pedido. Consecuencias:

- La Action arma las sesiones del sitio desde OpenF1. La primera corrida real procesó 5 sesiones en 6 minutos y publicó el sitio.
- El live tampoco puede salir de GitHub: ni el navegador (CORS) ni los runners (403) llegan al feed. Hace falta un proceso en una conexión que F1 acepte.
- La fixture de los tests solo se puede bajar desde una conexión hogareña; en la Action esos tests se saltean.

En OpenF1, el campo `date` de `pit` es el instante de **salida** de boxes (coincide con `InPit: false` del feed). Con eso la calle de boxes reconstruida desde OpenF1 da los mismos extremos que la del feed oficial.

## 7. Hallazgos para la v2 (2026-10-08)

Verificados contra la carrera de Bakú (fixture) y los mensajes de Race Control de las 21 carreras de 2026.

- **Cambios de posición:** `Position` (string) y `Line` en el delta de `TimingData`. 287 cambios en carrera, siempre de a dos o más en el mismo mensaje (114 mensajes con 2, 14 con 3 o más, ninguno con uno solo) y nunca con posiciones repetidas en un estado intermedio. 7 rebotes (vuelve a la posición anterior en menos de 4 s). Ninguno antes de la largada.
- **Grilla:** `GridPos` en `TimingAppData` (solo el feed oficial). OpenF1 no lo emite, pero la primera `Position` del primer `TimingData` es la grilla y coincide en las dos fuentes.
- **OpenF1 y el orden de carrera:** trae exactamente los mismos 287 cambios (mismo piloto, misma posición), con los mismos tiempos relativos. Los tiempos absolutos van corridos ~2 s contra el reloj del feed. El orden no hace falta rotularlo como aproximado; sí los retiros y el estado de pista.
- **Después de la bandera a cuadros** hubo 2 cambios, 28 s más tarde (P7↔P8): la reclasificación por una sanción. Son parte de la clasificación final.
- **Cierre de vuelta:** un delta con `NumberOfLaps` numérico, que trae en el mismo mensaje `LastLapTime`, `BestLapTime` y `Sectors[2].Value`.
- **Sanciones y comisarios (`RaceControlMessages`):** el piloto va solo en el texto; 0 de 61 sanciones de tiempo traen `RacingNumber`. Formatos vistos: `N SECOND TIME PENALTY FOR CAR n (TLA)`, `DRIVE THROUGH PENALTY FOR CAR…`, `STOP-AND-GO PENALTY FOR CAR…`, `PENALTY SERVED - …`, `WARNING FOR CAR…`, `INCIDENT INVOLVING CAR(S) … NOTED | UNDER INVESTIGATION | WILL BE INVESTIGATED AFTER THE RACE/SPRINT | REVIEWED NO FURTHER INVESTIGATION | NO FURTHER ACTION`. Variantes: prefijo `FIA STEWARDS:` (a veces `UPDATE:`), prefijo `TURN n` o `LAP n TURN n`, varios autos (`CARS 5 (BOR), 77 (BOT) AND 10 (GAS)`), motivo (` - …`) y hora `(HH:MM:SS)` opcionales. No aparecen descalificaciones ni reprimendas en 2026.
- **UNVERIFIED:** formato de las sanciones en sprint o clasificación más allá de lo listado; qué mensaje cierra una investigación que termina en sanción posterior (se encadena solo por piloto y motivo, no por un identificador).

## 8. Presupuestos medidos y lo que sigue sin comprobar (2026-10-08)

Medido en un laptop, con la carrera de Bakú (fixture, 22 pilotos):

| Qué | Tiempo | Presupuesto de la spec |
|---|---|---|
| `buildInsights` de una carrera completa | ~137 ms | 500 ms |
| Telemetría de una sesión (`buildTelemetry`) | ~1,4 s | sin presupuesto; corre en la Action y en el server, no en el navegador |

Sigue sin comprobarse (`UNVERIFIED`):

- Las condiciones de uso de OpenF1 y de MultiViewer para un sitio público (Lucas decidió no verificarlas: uso personal, no masivo). No se afirma ningún permiso: la atribución del pie y `docs/DATA_SOURCES.md` solo dicen de dónde sale cada dato.
- El formato de los mensajes del feed en vivo durante una sesión real (ver sección del live); se probó con la pista cerrada.
- Sanciones y comisarios fuera de las carreras de 2026 (ver sección 7).
- Los casos de sobrepaso conocidos para los tests contra datos reales: los elige Lucas.

Los tests de lo publicado (`packages/openf1/test`, `scripts/test`, `apps/server/test`) corren en CI sin red: el cliente de OpenF1 y el espejo reciben un `fetch` de mentira, y el server arma la app con una carga de sesión sintética.
