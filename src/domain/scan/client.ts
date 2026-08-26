/**
 * The call to the deployed parse-expiry proxy.
 *
 * This is the seam CaptureScreen used to stub out. It takes the base64 JPEG the
 * capture pipeline already produces, posts it, and returns either a prefill for
 * the Review & Save editor or a typed failure.
 *
 * It never throws. Every path — no config, no network, a rejected request, a
 * model that could not read the label — resolves to a `ScanResult`, because
 * every one of them ends the same way for the user: the editor opens and they
 * type it in. Manual entry is always available and a wrong date is worse than
 * no date.
 */
import { isScanConfigured, parseExpiryUrl, proxySecret } from '../../config/proxy';
import type { CaptureTimings } from './diagnostics';
import {
  MODEL_MS_HEADER,
  SCAN_ID_HEADER,
  SERVER_MS_HEADER,
  readTimingHeader,
  scanTrace,
  timingBreakdown,
} from './diagnostics';
import {
  describeRead,
  mappingDrops,
  readFields,
  reasonForStatus,
  scanFailure,
  toPrefill,
  type ScanResult,
} from './mapping';

/**
 * The vision call is not fast: the proxy resizes the image with sharp and then
 * waits on the model. Generous enough not to abandon a working request, short
 * enough that a dead network does not strand someone mid-unpack.
 *
 * The proxy's own budget is set under this — 12s per attempt at the model with
 * one retry — so a slow upstream produces a categorised failure from the server
 * rather than this abort firing first and reporting a bare timeout. Moving this
 * number means moving that one too.
 */
const TIMEOUT_MS = 30_000;

/**
 * The server's failure code, if it sent one we recognise.
 *
 * Read for the log only — never rendered, and never used to choose the copy;
 * the status still decides that, so a proxy deployed with new codes cannot
 * change what the app says. Bounded and type-checked because it is data from a
 * separately deployed service.
 */
async function failureCode(response: Response): Promise<string | undefined> {
  try {
    const body = (await response.json()) as { code?: unknown };
    return typeof body.code === 'string' ? body.code.slice(0, 40) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Did the proxy see the same scan id the phone sent?
 *
 * It echoes it back on every response. A mismatch means something between the
 * two rewrote or dropped the header — which would silently break the ability to
 * match the two log lines, so it is worth catching rather than discovering
 * later while trying to diagnose something else.
 */
function echoedId(response: Response): string | null {
  try {
    return response.headers.get(SCAN_ID_HEADER);
  } catch {
    return null;
  }
}

export async function scanPhoto(
  imageBase64: string,
  scanId: string,
  stopwatch: CaptureTimings,
): Promise<ScanResult> {
  const startedAt = Date.now();
  const kb = Math.round(imageBase64.length / 1024);

  /** Filled in from the proxy's headers once a response arrives. */
  let serverTimings: { serverMs?: number; modelMs?: number } = {};

  /**
   * One line per scan, always carrying the timing breakdown.
   *
   * `totalMs` is measured from the shutter rather than from this function, so
   * it is the whole elapsed life of the scan. Everything else divides that up —
   * including `queuedMs`, which since captures became non-blocking can be a
   * real share of it and must stay separable from time on the wire. A failure
   * gets the same treatment as a success: a scan that took eight seconds and
   * then failed is exactly the case worth accounting for.
   */
  const trace = (entry: Record<string, unknown>) => {
    const requestMs = Date.now() - startedAt;
    scanTrace(scanId, 'request', {
      ...timingBreakdown({
        totalMs: Date.now() - stopwatch.shutterAt,
        captureMs: stopwatch.captureMs,
        resizeMs: stopwatch.resizeMs,
        queuedMs: stopwatch.queuedMs,
        requestMs,
        ...serverTimings,
      }),
      kb,
      ...entry,
    });
  };

  if (!isScanConfigured() || proxySecret === null) {
    trace({ outcome: 'not-configured' });
    return scanFailure('not-configured');
  }

  // React Native's fetch has no built-in timeout, so an unreachable host would
  // otherwise hang until the OS gives up.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(parseExpiryUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${proxySecret}`,
        // The proxy adopts this as its own log id, so one scan is one
        // identifiable thing on both sides of the wire.
        [SCAN_ID_HEADER]: scanId,
      },
      body: JSON.stringify({ imageBase64 }),
      signal: controller.signal,
    });
  } catch (e) {
    // Only the error's `name` is recorded. The request carries the shared
    // secret in a header and error objects in some runtimes quote the request
    // back, so the object itself never reaches the log. `name` distinguishes
    // an abort from a transport failure, which is all this branch decides.
    //
    // Either way the request never reached the proxy, so there will be no
    // server-side line for this scan id at all — the absence is the evidence.
    const reason =
      e instanceof Error && e.name === 'AbortError' ? 'timeout' : 'network';
    trace({ outcome: reason, err: (e as Error)?.name, reachedProxy: false });
    return scanFailure(reason);
  } finally {
    clearTimeout(timer);
  }

  const echo = echoedId(response);

  // Read before anything can return: every branch below wants them, and a
  // failure's timing is as interesting as a success's.
  serverTimings = {
    serverMs: readTimingHeader(response.headers.get(SERVER_MS_HEADER)),
    modelMs: readTimingHeader(response.headers.get(MODEL_MS_HEADER)),
  };

  if (!response.ok) {
    const reason = reasonForStatus(response.status);
    trace({
      outcome: reason,
      status: response.status,
      code: await failureCode(response),
      idEchoed: echo === scanId,
    });
    return scanFailure(reason);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    trace({ outcome: 'malformed', status: response.status, at: 'json' });
    return scanFailure('malformed');
  }

  const fields = readFields(body);
  if (fields === null) {
    trace({ outcome: 'malformed', status: response.status, at: 'contract' });
    return scanFailure('malformed');
  }

  const prefill = toPrefill(fields);

  // A 200 is not the same as a useful read: the model can return nulls for
  // everything and still succeed. `read` separates "the pipeline works and the
  // photo was hard" from "the pipeline is broken", and `dropped` catches the
  // third case — our own mapping refusing something the server did send, which
  // should never happen and would otherwise look identical to a bad photo.
  trace({
    outcome: 'ok',
    status: response.status,
    read: describeRead(fields),
    dropped: mappingDrops(body, fields),
    type: prefill.dateType,
    checks: { name: prefill.needsNameCheck, date: prefill.needsDateCheck },
    idEchoed: echo === scanId,
  });

  return { ok: true, prefill };
}
