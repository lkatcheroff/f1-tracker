#!/usr/bin/env bash
# Deja armada la transcripción automática de la radio en esta Mac (macOS, launchd). Son dos tareas:
#  1. com.f1tracker.transcribe: cada 30 minutos, y al iniciar sesión, transcribe lo que falte y lo sube a GitHub
#     (scripts/transcribe-auto.sh). Si la Mac estaba dormida, corre al despertar.
#  2. com.f1tracker.radio-helper: un servicio en 127.0.0.1:8788 que la página consulta al abrir una sesión,
#     para mostrar el texto al instante (scripts/radio-helper.ts). Siempre encendido.
# Para quitarla: npm run transcribe:auto:remove
set -euo pipefail
cd "$(dirname "$0")/.."

LABEL="com.f1tracker.transcribe"
HOME_DIR="$HOME/Library/Application Support/f1-tracker-auto"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
ORIGIN="$(git remote get-url origin)"

mkdir -p "$HOME_DIR" "$HOME/Library/LaunchAgents"
if [ ! -d "$HOME_DIR/repo/.git" ]; then
  git clone -q "$ORIGIN" "$HOME_DIR/repo"
fi
# La copia usa tu identidad de git para firmar las transcripciones.
git -C "$HOME_DIR/repo" config user.name "$(git config user.name)"
git -C "$HOME_DIR/repo" config user.email "$(git config user.email)"
cp scripts/transcribe-auto.sh "$HOME_DIR/transcribe-auto.sh"
chmod +x "$HOME_DIR/transcribe-auto.sh"

cat >"$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>/bin/bash</string><string>$HOME_DIR/transcribe-auto.sh</string></array>
  <key>StartInterval</key><integer>1800</integer>
  <key>RunAtLoad</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>LowPriorityIO</key><true/>
  <key>Nice</key><integer>10</integer>
</dict>
</plist>
PLIST

HELPER="com.f1tracker.radio-helper"
HELPER_PLIST="$HOME/Library/LaunchAgents/$HELPER.plist"
cat >"$HELPER_PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$HELPER</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string><string>-c</string>
    <string>cd "$HOME_DIR/repo" &amp;&amp; exec node_modules/.bin/tsx scripts/radio-helper.ts</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>ProcessType</key><string>Background</string>
  <key>Nice</key><integer>5</integer>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/f1-tracker-radio-helper.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/f1-tracker-radio-helper.log</string>
</dict>
</plist>
PLIST

for pair in "$LABEL:$PLIST" "$HELPER:$HELPER_PLIST"; do
  launchctl bootout "gui/$(id -u)/${pair%%:*}" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "${pair#*:}"
done
echo "Instaladas las dos tareas. Registros: ~/Library/Logs/f1-tracker-transcribe.log y f1-tracker-radio-helper.log"
echo "Para correr la transcripción ahora: launchctl kickstart gui/$(id -u)/$LABEL"
