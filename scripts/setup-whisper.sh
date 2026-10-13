#!/usr/bin/env bash
# Instala Whisper (faster-whisper, código abierto) en un entorno propio del proyecto: .venv-whisper
# El modelo se baja solo la primera vez que se transcribe (small: unos 480 MB).
set -euo pipefail
cd "$(dirname "$0")/.."
python3 -m venv .venv-whisper
.venv-whisper/bin/pip install --quiet --upgrade pip
.venv-whisper/bin/pip install --quiet faster-whisper
echo "Listo: .venv-whisper con faster-whisper $(.venv-whisper/bin/pip show faster-whisper | sed -n 's/^Version: //p')"
