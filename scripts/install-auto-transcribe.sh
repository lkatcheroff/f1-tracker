#!/usr/bin/env bash
# Deja armada la transcripción automática de la radio en esta Mac (macOS, launchd).
# Cada 30 minutos, y al iniciar sesión, corre scripts/transcribe-auto.sh. Si la Mac estaba dormida, corre al despertar.
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

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "Instalada. Registro: ~/Library/Logs/f1-tracker-transcribe.log"
echo "Para correrla ahora: launchctl kickstart gui/$(id -u)/$LABEL"
