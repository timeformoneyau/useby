#!/usr/bin/env bash
# Installs the flow-test APK on the running emulator and runs every Maestro
# flow. One automatic retry: emulators occasionally stall for reasons that
# have nothing to do with the app, and one flake should not block a release.
# A second failure is treated as real.
set -euo pipefail

APK="${1:?usage: run-flows.sh path/to/app.apk}"
OUT="${MAESTRO_OUT:-.maestro-output}"
mkdir -p "$OUT"

adb install -r "$APK"

run() {
  maestro test e2e/flows \
    --format junit --output "$OUT/report-$1.xml" \
    --test-output-dir "$OUT/attempt-$1"
}

if run 1; then exit 0; fi
echo "::warning::Flow tests failed on the first attempt; retrying once."
run 2
