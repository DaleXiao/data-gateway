#!/bin/bash
# build.sh — Build MemCare dashboard by injecting health data into template
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HEALTH_DIR="$SCRIPT_DIR/../../memory/health"
TEMPLATE="$SCRIPT_DIR/index.template.html"
DIST_DIR="$SCRIPT_DIR/dist"

mkdir -p "$DIST_DIR"

# Collect all health JSON files (last 30 days)
DATA="{"
DATA+="\"days\":["
FIRST=true
for f in $(ls -1 "$HEALTH_DIR"/*.json 2>/dev/null | sort | tail -30); do
  if [[ "$FIRST" == "true" ]]; then FIRST=false; else DATA+=","; fi
  DATA+=$(cat "$f")
done
DATA+="],"

# ===== Important Topics: query lancedb directly =====
# importance >= 0.85 OR (importance >= 0.8 AND created in last 14 days)
# top 30, sort by importance desc then ts desc
IMPORTANT_JSON=$(python3 <<'PY'
import json, subprocess, sys, time, re
try:
    proc = subprocess.run([
        "openclaw","memory-pro","list",
        "--limit","5000","--json"
    ], capture_output=True, timeout=180)
    # openclaw memory-pro --json writes JSON to stderr; stdout has [plugins] banner
    raw_err = proc.stderr.decode("utf-8","replace")
    raw_out = proc.stdout.decode("utf-8","replace")
    # try stderr first (where JSON actually lives), then fall back to stdout
    candidates = [raw_err, raw_out]
    rows = None
    for c in candidates:
        clean = "\n".join(ln for ln in c.splitlines() if not ln.startswith("[plugins]")).strip()
        if clean.startswith("[") or clean.startswith("{"):
            rows = json.loads(clean)
            break
    if rows is None:
        print("[]"); sys.exit(0)
except Exception as e:
    sys.stderr.write(f"importantTopics build failed: {e}\n")
    print("[]")
    sys.exit(0)

now_ms = int(time.time()*1000)
fourteen_d = 14*24*3600*1000

seen = set()
picked = []
for e in rows:
    imp = e.get("importance") or 0
    ts = e.get("timestamp") or 0
    age_ms = now_ms - ts if ts else 999999999
    keep = (imp >= 0.85) or (imp >= 0.8 and age_ms <= fourteen_d)
    if not keep: continue
    txt = (e.get("text") or "").strip()
    if not txt: continue
    key = txt[:80]
    if key in seen: continue
    seen.add(key)
    picked.append({
        "id": e.get("id",""),
        "text": txt[:240],
        "importance": imp,
        "category": e.get("category",""),
        "scope": e.get("scope",""),
        "timestamp": ts,
    })

picked.sort(key=lambda x: (-x["importance"], -x["timestamp"]))
print(json.dumps(picked[:50], ensure_ascii=False))
PY
)
DATA+="\"importantTopics\":${IMPORTANT_JSON:-[]},"

# Latest data
LATEST=$(ls -1 "$HEALTH_DIR"/*.json 2>/dev/null | sort | tail -1)
if [[ -n "$LATEST" ]]; then
  DATA+="\"latest\":$(cat "$LATEST")"
else
  DATA+="\"latest\":{}"
fi
DATA+="}"

# Inject into template
if [[ ! -f "$TEMPLATE" ]]; then
  echo "ERROR: Template not found: $TEMPLATE" >&2
  exit 1
fi

# Use python to safely inject JSON (sed breaks on special chars in JSON)
python3 -c "
import sys
data = sys.argv[1]
with open(sys.argv[2]) as f:
    template = f.read()
result = template.replace('{{DATA_PLACEHOLDER}}', data)
with open(sys.argv[3], 'w') as f:
    f.write(result)
" "$DATA" "$TEMPLATE" "$DIST_DIR/index.html"

echo "✅ Built dist/index.html ($(wc -c < "$DIST_DIR/index.html") bytes)"
