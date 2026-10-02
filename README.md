# F1 Tracker

Página personal para seguir sesiones de F1 (gaps, tiempos, neumáticos, mapa) en dos modos: **replay** sincronizado con el video y **live**. Proyecto no oficial, sin afiliación con Formula 1.

## Uso

```bash
npm install
npm run dev
```

Abre `http://localhost:5173`. El server propio corre en `127.0.0.1:8787` (se cambia con `F1_SERVER_PORT`).

### Replay

1. Elegí la sesión en la lista (no muestra resultados).
2. Poné el video. Cuando se apagan los semáforos, apretá **Sync: largada**.
3. Si quedó corrido, usá **Ajuste fino** (±1 s, ±5 s) o el campo **Offset**. El offset se recuerda por sesión y se aplica en el próximo sync.

Atajos: espacio = play/pausa, ←/→ = ±5 s. La posición se guarda para retomar. Agregando `?t=<segundos>` a la URL de un replay se abre en ese punto.

Con **Sin spoilers** activado, la barra de avance va por vuelta y no se muestra la duración total.

Fuentes del replay, en este orden:

- **Archivo estático de F1**: disponible unos 30 minutos después del final de la sesión. Se baja una vez y queda en `data/cache/`.
- **OpenF1** ("vía OpenF1" en la lista): para sesiones que F1 todavía no publicó. La primera carga tarda cerca de un minuto por el rate limit.
- **Grabaciones propias**: lo que grabó el modo live, en `data/recordings/`.

### Live

**Seguir en vivo** conecta el server al feed SignalR de F1, sin cuenta, y graba todo lo que entra. El panel de topics muestra qué datos llegan. Sin cuenta de F1 no llegan posiciones ni telemetría, así que el live no tiene mapa. Ver `docs/spikes.md`.

## El mapa

Sobre el trazado se marcan: meta y sentido de giro, inicio de cada sector, números de curva, calle de boxes con entrada y salida, y las rectas largas (zonas típicas de sobrepaso; es una estimación por geometría, el feed no publica zonas oficiales).

En carrera: líder, quién tiene la vuelta rápida, autos a menos de 1 s del de adelante, banderas azules, autos detenidos en pista, el Safety Car mientras está desplegado, banderas amarillas por sector y el trazado teñido según el estado de pista. Al pasar el mouse por un auto se ve su gap, neumático y en qué posición saldría si parara ahora.

En práctica y clasificación: quién viene en vuelta con récord de sector, quién viene mejorando su marca y quién está en vuelta de salida o de entrada.

Curvas, sectores de banderilleros y costo de la parada salen de la API pública de MultiViewer. Si no responde, el mapa se dibuja sin esas marcas.

## Sitio en GitHub Pages

`npm run build:pages` arma una versión estática: el replay corre entero en el navegador (Web Worker), sin server. El workflow `.github/workflows/pages.yml` la publica y la mantiene al día:

- En cada push a `main`, y cada 15 minutos, corre `scripts/mirror.ts`: lee el calendario, baja las sesiones que falten, las procesa (1 a 4 MB cada una) y republica el sitio. Una sesión nueva aparece entre 45 y 75 minutos después de terminar.
- **Los datos del sitio salen de OpenF1**, no del archivo de F1: F1 le responde 403 a los servidores de GitHub. Respecto del feed oficial faltan el Safety Car en el mapa y los mini-sectores; los abandonos y el estado de pista son aproximados. Con `npm run dev` en tu máquina el replay usa el archivo oficial completo.
- Publica las últimas 40 sesiones (`MIRROR_MAX_SESSIONS` en el workflow), de a 5 nuevas por corrida por el rate limit de OpenF1. El resto, y las temporadas desde 2023, se cargan desde OpenF1 en el navegador; la primera carga tarda cerca de un minuto.
- El modo live no está en el sitio: necesita un server conectado al feed. Sigue disponible en local con `npm run dev`.

Para activarlo: repo público en GitHub, y en Settings → Pages → Source elegir "GitHub Actions".

Para probar el sitio estático en local:

```bash
MIRROR_SOURCE=openf1 npm run mirror -- site-data --max 4   # sin MIRROR_SOURCE usa el archivo de F1
npm run build:pages && cp -r site-data apps/web/dist/data
npx vite preview --outDir apps/web/dist
```

## Estructura

- `packages/core`: tipos, parser `.jsonStream`, decoder `.z`, `StateEngine` (deep-merge + checkpoints), `ReplayPlayer` (reloj + seek) e índice del replay. Sin I/O.
- `packages/openf1`: cliente de OpenF1 y traducción al formato del feed. Corre en el server y en el navegador.
- `apps/server`: Fastify + WebSocket. Replay, `LiveSource`, `Recorder`, caché en disco.
- `apps/web`: Vite + React. Timing tower, mapa, gráfico de gaps, Race Control. Habla con el server por WebSocket o, en el sitio estático, con un Web Worker.
- `scripts/mirror.ts`: arma los datos del sitio estático.
- `docs/SPEC.md`: la spec original. `docs/spikes.md`: resultados de la Fase 0.

Los dos modos usan el mismo formato de mensajes y el mismo `StateEngine`; cambia solo la fuente.

## Tests

```bash
npm run fixture   # baja la carrera de Azerbaiyán 2026 a fixtures/ (25 MB)
npm test
npm run typecheck
```

Los tests del engine comparan posiciones, gaps y neumáticos en cuatro momentos de esa carrera. Sin la fixture se saltean.

## Diferencias con la spec

- **npm workspaces en vez de pnpm**: pnpm no estaba instalado y el de corepack fallaba. La estructura es la misma.
- **Cliente SignalR propio** (unas 100 líneas sobre `ws`) en vez de `@microsoft/signalr`: hace falta mandar la cookie del balanceador en el WebSocket.
- **Mirror de FastF1**: responde 404, no se usa.
- **El replay no pasa por la interface `DataSource`**: lo maneja `ReplayPlayer` sobre la lista completa de mensajes, para que el mismo código corra en el server y en el navegador. `DataSource` queda para el live.
