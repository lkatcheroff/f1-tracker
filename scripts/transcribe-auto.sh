#!/usr/bin/env bash
# Transcribe la radio de las sesiones nuevas y sube el texto a GitHub. Lo dispara launchd (ver install-auto-transcribe.sh).
# Trabaja en una copia propia del repositorio, así no toca los cambios que haya en el repositorio principal.
set -uo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

HOME_DIR="$HOME/Library/Application Support/f1-tracker-auto"
REPO="$HOME_DIR/repo"
LOG="$HOME/Library/Logs/f1-tracker-transcribe.log"
mkdir -p "$(dirname "$LOG")"
exec >>"$LOG" 2>&1
echo "=== $(date '+%Y-%m-%d %H:%M:%S')"

# Una sola corrida a la vez.
LOCK="$HOME_DIR/lock"
if ! mkdir "$LOCK" 2>/dev/null; then
  echo "ya hay una corrida en marcha; se saltea"
  exit 0
fi
trap 'rmdir "$LOCK"' EXIT

cd "$REPO" || { echo "falta la copia en $REPO: corré npm run transcribe:auto:install"; exit 1; }

# Siempre al día con GitHub (la copia es solo de la herramienta).
git fetch -q origin main || { echo "sin conexión a GitHub"; exit 1; }
git reset -q --hard origin/main

# Dependencias: solo se reinstalan si cambiaron.
SUM="$(shasum package-lock.json | cut -d' ' -f1)"
if [ ! -d node_modules ] || [ "$(cat "$HOME_DIR/lock-sum" 2>/dev/null)" != "$SUM" ]; then
  npm ci --silent && echo "$SUM" >"$HOME_DIR/lock-sum" || exit 1
fi
[ -x .venv-whisper/bin/python ] || bash scripts/setup-whisper.sh || exit 1

npm run --silent transcribe -- --max-sessions 6 || exit 1

# Si hay texto nuevo, se sube. Un push a main republica el sitio.
if [ -n "$(git status --porcelain -- transcripts)" ]; then
  git add transcripts
  git commit -q -m "Transcripciones de la radio (automático)"
  git push -q origin main || { git pull -q --rebase origin main && git push -q origin main; } || exit 1
  echo "subidas las transcripciones nuevas"
else
  echo "nada nuevo para subir"
fi
