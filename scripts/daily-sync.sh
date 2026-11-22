#!/bin/bash
set -eu
export PATH="$HOME/.local/go/bin:$HOME/.local/node/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export GIT_TERMINAL_PROMPT=0 GH_PROMPT_DISABLED=1 PYTHONDONTWRITEBYTECODE=1
cd "$(dirname "$0")/.."
exec /usr/bin/python3 scripts/operations/personal_sync.py "$@"
