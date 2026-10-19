#!/usr/bin/env bash
# Installs the flow-test APK on the running emulator and runs every Maestro
# flow. One automatic retry: emulators occasionally stall for reasons that
# have nothing to do with the app, and one flake should not block a release.
# A second failure is treated as real.
set -euo pipefail
# pipefail keeps maestro's exit status through the tee to the log.

APK="${1:?usage: run-flows.sh path/to/app.apk}"
OUT="${MAESTRO_OUT:-.maestro-output}"
mkdir -p "$OUT"

adb install -r "$APK"

run() {
  maestro test e2e/flows \
    --format junit --output "$OUT/report-$1.xml" \
    --test-output-dir "$OUT/attempt-$1" 2>&1 | tee -a "$OUT/maestro.log"
}

# What was on screen and what the app logged, saved while the emulator is
# still up. CI posts these as annotations when the flows fail.
diagnose() {
  adb shell uiautomator dump /sdcard/ui.xml > /dev/null 2>&1 || true
  adb shell cat /sdcard/ui.xml 2>/dev/null \
    | grep -o 'text="[^"]*"\|content-desc="[^"]*"\|package="[^"]*"' \
    | grep -v '=""' | sort -u > "$OUT/screen.txt" || true
  adb logcat -d -v time 'ReactNativeJS:V' 'ReactNative:V' 'AndroidRuntime:E' 'Expo:V' '*:F' \
    > "$OUT/logcat.txt" 2>/dev/null || true
}

if run 1; then exit 0; fi
diagnose
echo "::warning::Flow tests failed on the first attempt; retrying once."
adb logcat -c || true
if run 2; then exit 0; fi
diagnose
exit 1
