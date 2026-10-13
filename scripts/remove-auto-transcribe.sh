#!/usr/bin/env bash
# Quita la transcripción automática de la radio (deja las transcripciones ya subidas).
set -euo pipefail
LABEL="com.f1tracker.transcribe"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/$LABEL.plist"
rm -rf "$HOME/Library/Application Support/f1-tracker-auto"
echo "Quitada. El registro queda en ~/Library/Logs/f1-tracker-transcribe.log"
