#!/usr/bin/env bash
# Every Mind check that needs no person and no API key. Run before each push.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p logs

echo "== src/ uses no Node-only modules"
bad=$(grep -nvE "^\s*//" src/*.ts | grep -E "from ['\"](node:|fs|path|os|child_process|net|http|https|crypto|url|ws|dotenv)['\"/]|require\(|process\.(env|argv|exit)|__dirname|import\.meta" || true)
if [ -n "$bad" ]; then echo "$bad"; echo "FAIL: Node-only code under src/"; exit 1; fi
echo "ok"

echo "== type check"
npx tsc --noEmit -p . > logs/tsc.log 2>&1 || { tail -20 logs/tsc.log; echo "FAIL: type check"; exit 1; }
echo "ok"

echo "== tests (model stubbed out)"
# Make sure no key is used by the tests.
OPENAI_API_KEY= npx tsx --test test/*.test.ts > logs/test.log 2>&1 || { grep -E "^(✖|not ok)|Error" logs/test.log | head -30; tail -8 logs/test.log; echo "FAIL: tests"; exit 1; }
grep -E "^ℹ (tests|pass|fail)" logs/test.log
echo "check.sh: all good"
