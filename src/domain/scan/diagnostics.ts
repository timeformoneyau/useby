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
 * Timing the proxy reports back, so one log line accounts for a whole scan.
 *
 * Without these the phone knows only how long the round trip took, and telling
 * "the model was slow" from "the upload was slow" would mean pulling the
 * matching server line out of Vercel — which retains runtime logs for about an
 * hour on the current plan. Reading them here keeps a scan diagnosable from the
 * device alone.
 */
export const SERVER_MS_HEADER = 'X-UseBy-Server-Ms';
export const MODEL_MS_HEADER = 'X-UseBy-Model-Ms';

/**
 * What the phone measured before the request went out.
 *
 * Handed to `scanPhoto` rather than measured inside it, because the wait that
 * matters starts at the shutter — the capture and the resize happen before the
 * network is involved at all, and on a slow phone they are not free.
 */
export type CaptureTimings = {
  /** `Date.now()` at the moment the shutter was pressed. */
  shutterAt: number;
  captureMs: number;
  resizeMs: number;
  /**
   * How long the scan sat in the queue before its request went out.
   *
   * Supplied by the queue, which is the only thing that knows it. Optional
   * because a scan that found a free slot immediately did not queue at all, and
   * logging `0` for that is a different claim from logging nothing.
   */
  queuedMs?: number;
};

/** Where a scan's seconds went. Every field is milliseconds. */
export type ScanTimings = {
  /**
   * Shutter to result.
   *
   * Still measured from the shutter, and still the elapsed life of the scan —
   * but since captures became non-blocking this is no longer time anyone spent
   * waiting. The camera came back immediately; this ran on in the background.
   * `queuedMs` is what keeps the number decomposable rather than merely larger.
   */
  totalMs: number;
  /** `takePictureAsync` — the shutter and the file write. */
  captureMs: number;
  /** `manipulateAsync` — resize, JPEG re-encode and base64 encode. */
  resizeMs: number;
  /**
   * Waiting for a concurrency slot. Not latency — nothing was happening.
   *
   * Kept as its own field rather than folded into `requestMs`, so a queue that
   * is too tight can never be misread as a slow network or a slow model. If
   * this is consistently large, the cap is wrong; if it is near zero, the cap
   * is not what is costing time.
   */
  queuedMs?: number;
  /** The whole `fetch`, request to parsed response. */
  requestMs: number;
  /** The proxy's own elapsed time, from its header. Absent if it did not say. */
  serverMs?: number;
  /** The Anthropic call, from the proxy's header. Only present on a success. */
  modelMs?: number;
};

/**
 * Turn raw stopwatch readings into the breakdown worth logging.
 *
 * The one derived figure is `overheadMs`: the round trip less whatever the
 * server says it spent, which is everything that is neither the phone nor the
 * proxy — DNS, TLS, uploading ~300KB over mobile data, Vercel's routing and any
 * cold start, and the response coming back. React Native's `fetch` exposes no
 * transfer timings, so upload and download genuinely cannot be separated; one
 * honest aggregate is better than an invented split.
 *
 * Clamped at zero. The two clocks are different machines, so rounding or a
 * little skew can make the subtraction negative, and a negative "overhead"
 * reads as a bug rather than as the noise it is.
 */
export function timingBreakdown(timings: ScanTimings): Record<string, number> {
  const { totalMs, captureMs, resizeMs, queuedMs, requestMs, serverMs, modelMs } =
    timings;

  return {
    totalMs,
    captureMs,
    resizeMs,
    ...(queuedMs === undefined ? {} : { queuedMs }),
    requestMs,
    ...(serverMs === undefined
      ? {}
      : { serverMs, overheadMs: Math.max(0, requestMs - serverMs) }),
    ...(modelMs === undefined ? {} : { modelMs }),
  };
}

/**
 * Read one of the proxy's timing headers.
 *
 * Data from a separately deployed service, so it is parsed defensively and
 * bounded: anything absent, non-numeric, negative or implausibly large is
 * dropped rather than logged as fact. An hour is far beyond any value this
 * pipeline can legitimately produce — the client gives up at 30 seconds.
 */
export function readTimingHeader(value: string | null): number | undefined {
  if (value === null) return undefined;

  // `Number('')` and `Number('   ')` are both 0, so an empty header would
  // otherwise be recorded as a measured zero milliseconds — a fabricated
  // reading that looks exactly like a real one. Reject blank before parsing.
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;

  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 3_600_000) return undefined;
  return Math.round(parsed);
}

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
