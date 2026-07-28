#!/usr/bin/env bash
# Prepare the Uni Stuttgart LaTeX Benchmark project and run it through
# Undertwig's SwiftLaTeX PdfTeX WASM engine. Exit 0 only if a PDF is produced
# for prepare + timed runs.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
WORK_DIR="${BENCH_WORK_DIR:-$SCRIPT_DIR/.work}"
UPSTREAM_URL="${BENCH_UPSTREAM_URL:-https://web.itp3.uni-stuttgart.de/latex-benchmark/latex-benchmark.git}"
PORT="${BENCH_PORT:-}"
RUNS="${BENCH_RUNS:-3}"
RESULTS_PATH="${BENCH_RESULTS_PATH:-$SCRIPT_DIR/results.json}"

if [[ -z "$PORT" ]]; then
  PORT="$(python3 - <<'PY'
import socket
s = socket.socket()
s.bind(("127.0.0.1", 0))
print(s.getsockname()[1])
s.close()
PY
)"
fi

rm -rf "$WORK_DIR"
mkdir -p "$WORK_DIR/harness" "$WORK_DIR/project"

echo "==> Cloning upstream latex-benchmark"
git clone --quiet "$UPSTREAM_URL" "$WORK_DIR/upstream"

echo "==> Staging project files"
cp -a "$WORK_DIR/upstream/benchmark/." "$WORK_DIR/project/"
# Drop any generated TeX junk if present in the upstream tree.
find "$WORK_DIR/project" -type f \( \
  -name '*.aux' -o -name '*.log' -o -name '*.out' -o -name '*.toc' -o -name '*.pdf' \
\) ! -path '*/figures/*' -delete 2>/dev/null || true
cp "$WORK_DIR/project/QFT.tex" "$WORK_DIR/project/main.tex"
cp "$SCRIPT_DIR/fixtures/main.bbl" "$WORK_DIR/project/main.bbl"
cp "$SCRIPT_DIR/fixtures/main.brf" "$WORK_DIR/project/main.brf"

# Harness-only workaround: SwiftLaTeX leaves \clearpage undefined at \end{document}
# for this KOMA + hyperref/backref document. See docs/benchmarks/latex-benchmark.md.
python3 - "$WORK_DIR/project/main.tex" <<'PY'
from pathlib import Path
import sys
path = Path(sys.argv[1])
text = path.read_text()
needle = "\\end{document}"
idx = text.rfind(needle)
if idx < 0:
    raise SystemExit("main.tex has no \\end{document}")
footer = (
    "% Undertwig harness workaround — see docs/benchmarks/latex-benchmark.md\n"
    "\\makeatletter\n"
    "\\def\\clearpage{\\newpage}\n"
    "\\makeatother\n"
    "\\end{document}\n"
)
path.write_text(text[:idx] + footer)
print("Applied clearpage workaround")
PY

python3 - "$WORK_DIR/project" "$WORK_DIR/harness/project-manifest.json" <<'PY'
import json, os, sys
root = sys.argv[1]
out = sys.argv[2]
skip = {".gitignore"}
manifest = []
for dirpath, _, files in os.walk(root):
    for name in files:
        if name in skip:
            continue
        path = os.path.join(dirpath, name)
        rel = os.path.relpath(path, root).replace("\\", "/")
        binary = rel.lower().endswith((".pdf", ".png", ".jpg", ".jpeg", ".wasm"))
        manifest.append({"path": rel, "url": "/project/" + rel, "binary": binary})
with open(out, "w", encoding="utf-8") as fh:
    json.dump(manifest, fh, indent=2)
    fh.write("\n")
print(f"Manifest entries: {len(manifest)}")
PY

ln -sfn "$REPO_ROOT/vendor" "$WORK_DIR/harness/vendor"
ln -sfn "$WORK_DIR/project" "$WORK_DIR/harness/project"
cp "$SCRIPT_DIR/run.html" "$WORK_DIR/harness/run.html"

echo "==> Installing Playwright"
cd "$SCRIPT_DIR"
if [[ ! -d node_modules/playwright ]]; then
  if [[ -f package-lock.json ]]; then
    npm ci --no-fund --no-audit
  else
    npm install --no-fund --no-audit
  fi
fi
if [[ "${SKIP_PLAYWRIGHT_INSTALL:-}" != "1" ]]; then
  npx playwright install chromium
fi

echo "==> Starting static server on :$PORT"
cd "$WORK_DIR/harness"
python3 -m http.server "$PORT" >/tmp/undertwig-bench-server.log 2>&1 &
SERVER_PID=$!
cleanup() {
  kill "$SERVER_PID" 2>/dev/null || true
}
trap cleanup EXIT

for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:$PORT/run.html" >/dev/null; then
    break
  fi
  sleep 0.2
done
curl -fsS "http://127.0.0.1:$PORT/vendor/swiftlatex/PdfTeXEngine.js" >/dev/null
curl -fsS "http://127.0.0.1:$PORT/project/main.tex" >/dev/null

echo "==> Running Undertwig PdfTeX benchmark ($RUNS timed runs)"
cd "$SCRIPT_DIR"
BENCH_PORT="$PORT" \
BENCH_RUNS="$RUNS" \
BENCH_RESULTS_PATH="$RESULTS_PATH" \
node drive.mjs

echo "==> PASS"
python3 - "$RESULTS_PATH" <<'PY'
import json, sys
data = json.load(open(sys.argv[1]))
results = data.get("results") or {}
print(
    "min={min}s avg={avg}s max={max}s pdfBytes={pdfBytes}".format(
        min=results.get("min"),
        avg=results.get("avg"),
        max=results.get("max"),
        pdfBytes=results.get("pdfBytes"),
    )
)
PY
