#!/bin/bash
# PLANNER-OWNED
set -e; cd "$(dirname "$0")/.."; node ../common_check.mjs .; node checks/e2e.mjs
# optional live free provider check (network): only if LIVE=1
if [ "$LIVE" = 1 ]; then node -e "import('./src/translate/mymemory.js').then(async m=>{const t=await m.translate('Where is the train station?','en','zh');console.log('mymemory:',t);if(!/[\u4e00-\u9fff]/.test(t))process.exit(1)})"; fi
node checks/grill_e2e.mjs
node checks/qa_heavy.mjs
