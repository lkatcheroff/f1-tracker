# Fuentes de datos

Qué fuente se usa para qué, qué falta con cada una y dónde están sus términos. El proyecto es personal y no oficial.

> **Términos de uso:** no se verificaron. Decisión de Lucas (2026-10-08): es un proyecto personal de uso no masivo. Este documento solo dice de dónde sale cada dato y **no afirma ningún permiso**.

| Fuente | Se usa para | Dónde corre | Términos |
|---|---|---|---|
| Archivo de tiempos de F1 (`livetiming.formula1.com/static`) | Replay completo con el server local: tiempos, posiciones, telemetría, Safety Car, mini-sectores reales | Solo en local, desde una conexión hogareña | Sin términos públicos para este endpoint que se hayan podido comprobar. Responde 403 a los servidores de GitHub |
| Feed en vivo de F1 (SignalR) | Modo live y grabaciones | Solo en local | Ídem. Sin cuenta de F1 no trae posiciones ni telemetría |
| [OpenF1](https://openf1.org) | Todas las sesiones del sitio publicado y las que se abren "vía OpenF1" | Action de GitHub y navegador | Ver <https://openf1.org> (el plan gratuito limita a 3 pedidos por segundo y 30 por minuto) |
| [MultiViewer](https://multiviewer.app) | Números de curva, sectores de banderilleros, orientación del circuito y costo estimado de la parada | Navegador | API pública sin documentación de términos que se haya podido comprobar. Si no responde, el mapa se dibuja sin esas marcas |

## Qué cambia según la fuente

| | Archivo oficial | OpenF1 | Grabación en vivo |
|---|---|---|---|
| Orden de carrera y cambios de posición | Sí | Sí, los mismos | Sí |
| Posiciones en el mapa | Sí | Sí | No |
| Telemetría y comparación | Sí | Sí, casi idéntica (mismo tiempo de vuelta al ms, 0,7 km/h de diferencia media) | No |
| Mini-sectores | Reales: color y momento | El color es el real; el momento en que se completa cada uno se reparte en partes iguales del sector | Según lo que mande el feed |
| Abandonos | Del feed | Deducidos del resultado final: aproximados | Del feed |
| Estado de pista (Safety Car, banderas) | Del feed | Deducido de los mensajes de Race Control: aproximado | Del feed |
| Safety Car en el mapa | Sí | No | No |
| Radio de los equipos (audio) | No (en esta versión) | Sí: enlace al mp3 de cada mensaje | No |
| Parrilla oficial | `GridPos` del feed | Sí, de la clasificación del mismo fin de semana | No |
| Tiempo parado en boxes | No | Solo cuando OpenF1 lo informa (2025 sí; 2024 y 2026 vienen vacíos) | No |
| Campeonato | No (en esta versión) | Sí, solo en carrera y sprint | No |
| Tiempo restante de la sesión | Reloj de la transmisión | Reconstruido con la duración de cada parte y las banderas rojas | Del feed |

Cada sesión lleva su `dataQuality` y la pantalla muestra un aviso cuando la fuente no es el archivo oficial. Los eventos que dependen de una aproximación llevan un ≈ delante.

## Verificado y no verificado

Los hallazgos medidos (formatos de mensajes, coincidencia entre OpenF1 y el feed oficial, instante de salida de boxes) están en [`spikes.md`](./spikes.md). Lo que figura allí como `UNVERIFIED` sigue sin comprobarse.

## Reloj de sesión con OpenF1

OpenF1 no publica el cronómetro de práctica y clasificación. El adaptador lo reconstruye: arranca cuando se abre la calle de boxes, se detiene con la bandera roja, vuelve a su duración al empezar cada parte y llega a cero con la bandera a cuadros. La duración de cada parte sale del reglamento (práctica 60 min; clasificación 18, 15 y 12; clasificación sprint 12, 10 y 8). Si una parte corrió sin banderas rojas, manda lo observado, porque la duración real puede cambiar de una sesión a otra.

Comparado con el reloj oficial en la clasificación de Bakú 2026 (instantes de control en Q1, Q2 y Q3): diferencia de 0 segundos en los seis. Es una sola sesión: con bandera roja el reloj reconstruido puede desviarse unos segundos, y por eso el aviso de calidad de la sesión lo declara.

## Mini-sectores con OpenF1

OpenF1 publica el color final de cada mini-sector (violeta, verde, amarillo) por vuelta, pero no cuándo se completó. El adaptador reparte el tiempo del sector en partes iguales. Se probó repartir por distancia recorrida (posición del auto) y se midió contra el feed oficial de la clasificación de Bakú 2026 (9.300 mini-sectores): error mediano de 1,3 s con los dos métodos, sin diferencia, así que quedó el más simple. Los límites oficiales de cada mini-sector no se publican. Para el momento exacto hace falta el archivo oficial.

## Datos extra de OpenF1

- **Radio:** `team_radio` da la hora, el piloto y la dirección de un mp3 corto en el archivo de F1. El audio lo reproduce el navegador del que mira; el sitio no lo copia ni lo aloja. No hay transcripción.
- **Parrilla:** `starting_grid` está asociada a la sesión de **clasificación** del fin de semana, no a la carrera (con la clave de la carrera responde vacío). El cargador busca la clasificación del mismo fin de semana (la clasificación sprint, para el sprint).
- **Tiempo parado:** `pit.stop_duration` viene `null` en todas las paradas de 2024 y 2026 y completo en 2025. Se usa cuando existe; si no, la crónica solo cuenta el paso por la calle de boxes.
- **Campeonato:** `championship_drivers` y `championship_teams` traen posición y puntos antes y después de la carrera. Se publican en el momento de la bandera a cuadros para no delatar el resultado.
- **Clima:** el feed oficial y OpenF1 traen los mismos campos; se agregó la presión, que no se usaba.
