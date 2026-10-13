#!/usr/bin/env bash
# Quita la transcripción automática de la radio (deja las transcripciones ya subidas).
set -euo pipefail
LABEL="com.f1tracker.transcribe"
for label in "$LABEL" com.f1tracker.radio-helper; do
  launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
  rm -f "$HOME/Library/LaunchAgents/$label.plist"
done
rm -rf "$HOME/Library/Application Support/f1-tracker-auto"
echo "Quitada. El registro queda en ~/Library/Logs/f1-tracker-transcribe.log"
