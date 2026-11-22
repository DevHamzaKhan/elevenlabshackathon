#!/bin/sh
# Keeps a Bobby build going in Claude Code.
# If Claude tries to end its turn while the file .bobby-run exists at the repo
# root, this sends it back to work. Claude deletes that file when its part is
# done, or when only things that need a person are left.
cat >/dev/null
root="${CLAUDE_PROJECT_DIR:-.}"
marker="$root/.bobby-run"
[ -f "$marker" ] || exit 0

# Safety valve: if Claude keeps stopping within seconds of being sent back,
# it has nothing left it can do, so let it stop.
count_file="$root/.bobby-run.count"
now=$(date +%s)
last=0; count=0
if [ -f "$count_file" ]; then
  read -r last count < "$count_file" || true
fi
case "$last$count" in *[!0-9]*|"") last=0; count=0;; esac
if [ $((now - last)) -lt 30 ]; then count=$((count + 1)); else count=1; fi
echo "$now $count" > "$count_file"
if [ "$count" -gt 4 ]; then
  rm -f "$count_file"
  exit 0
fi

cat <<'JSON'
{"decision":"block","reason":"You stopped, but the file .bobby-run says your part is still in progress. Re-read your STATUS.md and carry on with the next item, without asking. If everything is done, or only items that need the human are left, update STATUS.md, delete .bobby-run, and then stop."}
JSON
