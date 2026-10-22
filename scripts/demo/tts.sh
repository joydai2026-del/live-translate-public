#!/bin/bash
# Renders the voiceover with a local Kokoro TTS install (set TTS_DIR to it) into /tmp/lt-demo/vo, plus durations.json.
# The int8 model's timing varies run to run, so each line gets TAKES takes (default 3) and the median-length take is kept.
# Existing takes are reused, so a run that was cut off resumes where it stopped.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; OUT=/tmp/lt-demo/vo; TTS="${TTS_DIR:?set TTS_DIR to a Kokoro TTS folder with bin/python and say.py}"
mkdir -p "$OUT"
n=$(node -e "console.log(require('$HERE/scenes.json').length)")
for i in $(seq 0 $((n-1))); do
  id=$(node -e "console.log(require('$HERE/scenes.json')[$i].id)")
  text=$(node -e "console.log(require('$HERE/scenes.json')[$i].text)")
  [ -f "$OUT/$id.wav" ] && continue  # resume: keep lines already rendered
  for k in $(seq 1 "${TAKES:-3}"); do [ -f "$OUT/$id.take$k.wav" ] || "$TTS/bin/python" -I "$TTS/say.py" "$OUT/$id.take$k.wav" "$text" af_heart 1.0 >/dev/null; done
  best=$(for k in $(seq 1 "${TAKES:-3}"); do echo "$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$OUT/$id.take$k.wav") $k"; done | sort -n | sed -n "$(( (${TAKES:-3} + 1) / 2 ))p" | cut -d' ' -f2)
  cp "$OUT/$id.take$best.wav" "$OUT/$id.wav"
done
node -e "
const cp=require('child_process'),s=require('$HERE/scenes.json'),d={};
for(const x of s) d[x.id]=+cp.execSync('ffprobe -v error -show_entries format=duration -of csv=p=0 $OUT/'+x.id+'.wav').toString();
require('fs').writeFileSync('$OUT/durations.json',JSON.stringify(d,null,1));console.log(d)"
