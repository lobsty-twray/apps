#!/usr/bin/env bash
set -euo pipefail
if [ $# -lt 2 ]; then
  echo "Usage: $0 <app-name> <port>"
  exit 1
fi
cd ~/apps
node scripts/screenshot.mjs "$1" "$2"
