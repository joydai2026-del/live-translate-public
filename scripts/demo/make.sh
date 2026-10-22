#!/bin/bash
# Full pipeline: voiceover (shared Kokoro TTS), recording (retried if the browser crashes), edit -> evidence/demo.mp4
set -uo pipefail
cd "$(dirname "$0")/../.."
bash scripts/demo/tts.sh || exit 1
for try in 1 2 3 4 5 6; do
  node scripts/demo/record.mjs && break
  echo "record try $try failed, retrying"
  [ "$try" = 6 ] && exit 1
done
python3 scripts/demo/build.py
