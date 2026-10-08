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
| Mini-sectores | Reales | Repartidos en partes iguales: aproximados | Según lo que mande el feed |
| Abandonos | Del feed | Deducidos del resultado final: aproximados | Del feed |
| Estado de pista (Safety Car, banderas) | Del feed | Deducido de los mensajes de Race Control: aproximado | Del feed |
| Safety Car en el mapa | Sí | No | No |

Cada sesión lleva su `dataQuality` y la pantalla muestra un aviso cuando la fuente no es el archivo oficial. Los eventos que dependen de una aproximación llevan un ≈ delante.

## Verificado y no verificado

Los hallazgos medidos (formatos de mensajes, coincidencia entre OpenF1 y el feed oficial, instante de salida de boxes) están en [`spikes.md`](./spikes.md). Lo que figura allí como `UNVERIFIED` sigue sin comprobarse.
