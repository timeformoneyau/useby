/**
 * What the phone records about a scan.
 *
 * The screen tells the person one plain sentence and nothing more — no status
 * codes, no confidence readouts, no identifiers. That is the accepted design
 * and none of this changes it. But a failed scan has to be explainable
 * afterwards, and "it said it couldn't read it" is not something anyone can act
 * on, so each scan also writes a line to the Android log:
 *
 *   adb logcat -s ReactNativeJS | grep useby.scan
 *
 * One event name for the whole scan, with a `stage` saying which half it came
 * from. That mirrors the proxy, which emits one `"evt":"parse-expiry"` line per
 * request, so the same grep habit works on both sides of the wire.
 *
 * Nothing secret goes in these lines. Not the bearer token, not the image, not
 * the error object — which in some runtimes stringifies the request that
 * produced it, headers included. Not the item name the model read, either: that
 * is the contents of someone's fridge, and presence and length answer the
 * diagnostic question without recording it.
 */

/**
 * Header the scan id travels in. Matched by `SCAN_ID_HEADER` in the proxy's
 * `lib/validate.ts`, which validates it before letting it near a log line.
 */
export const SCAN_ID_HEADER = 'X-UseBy-Scan-Id';

/**
 * Name one scan, once, at the shutter.
 *
 * The id is minted before the photo is taken rather than before the request is
 * sent, so a scan that dies during capture — and therefore never reaches the
 * proxy at all — still has a name. It is written into the phone's log line and
 * sent to the proxy, which adopts it for its own, so the two halves of a failed
 * scan can be reassembled without guessing from timestamps.
 *
 * Deliberately not a UUID: React Native's Hermes runtime has no
 * `crypto.randomUUID` without a polyfill, and this is a correlation id rather
 * than anything that has to be unguessable. The leading base-36 timestamp makes
 * an id sort by time, which is what turns "it failed about an hour ago" into a
 * bounded search. The character set is constrained to what the proxy accepts.
 */
export function newScanId(): string {
  const stamp = Date.now().toString(36);
  const rand = Math.floor(Math.random() * 0x1000000)
    .toString(36)
    .padStart(5, '0');
  return `p-${stamp}-${rand}`;
}

/** True for an id this build could have produced and the proxy will accept. */
export function isScanId(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/.test(value);
}

/** Which half of the scan a line came from. */
export type ScanStage = 'capture' | 'request';

/**
 * Write one line.
 *
 * `console.log` rather than anything cleverer because it is what reaches
 * `logcat` from a release build, which is the build being tested — Expo's
 * default Metro and Babel configuration strips no console calls, so these
 * survive into the preview APK. Verified against the built bundle rather than
 * assumed; a stripped log here would make the whole exercise pointless.
 */
export function scanTrace(
  scanId: string,
  stage: ScanStage,
  entry: Record<string, unknown>,
): void {
  console.log(`useby.scan ${JSON.stringify({ scanId, stage, ...entry })}`);
}
