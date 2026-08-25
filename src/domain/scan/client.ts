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
import {
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
 * One line per scan, to `adb logcat`.
 *
 * The app deliberately shows the user nothing about *why* a scan failed beyond
 * one sentence of plain copy — that is the accepted design, and a status code
 * in the UI would help nobody standing at a kitchen bench. But during Phase 3A
 * the person holding the phone is also the person diagnosing it, and "it said
 * it couldn't read it" is not enough to act on. This closes that gap without
 * touching the interface: `adb logcat -s ReactNativeJS | grep useby.scan` gives
 * the outcome, the HTTP status, the server's own failure code and where the
 * time went.
 *
 * Nothing secret goes in it. Not the bearer token, not the image, not the
 * error object — which in some runtimes stringifies the request that produced
 * it, headers included. Only the fields named below, all of them either numbers
 * or values from a closed set.
 */
function trace(entry: Record<string, unknown>) {
  console.log(`useby.scan ${JSON.stringify(entry)}`);
}

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

export async function scanPhoto(imageBase64: string): Promise<ScanResult> {
  const startedAt = Date.now();
  const kb = Math.round(imageBase64.length / 1024);

  if (!isScanConfigured() || proxySecret === null) {
    trace({ outcome: 'not-configured', kb });
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
      },
      body: JSON.stringify({ imageBase64 }),
      signal: controller.signal,
    });
  } catch (e) {
    // Only the error's `name` is recorded. The request carries the shared
    // secret in a header and error objects in some runtimes quote the request
    // back, so the object itself never reaches the log. `name` distinguishes
    // an abort from a transport failure, which is all this branch decides.
    const reason =
      e instanceof Error && e.name === 'AbortError' ? 'timeout' : 'network';
    trace({ outcome: reason, kb, ms: Date.now() - startedAt, err: (e as Error)?.name });
    return scanFailure(reason);
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const reason = reasonForStatus(response.status);
    trace({
      outcome: reason,
      status: response.status,
      code: await failureCode(response),
      kb,
      ms: Date.now() - startedAt,
    });
    return scanFailure(reason);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    trace({ outcome: 'malformed', status: response.status, at: 'json', kb, ms: Date.now() - startedAt });
    return scanFailure('malformed');
  }

  const fields = readFields(body);
  if (fields === null) {
    trace({ outcome: 'malformed', status: response.status, at: 'contract', kb, ms: Date.now() - startedAt });
    return scanFailure('malformed');
  }

  const prefill = toPrefill(fields);

  // A 200 is not the same as a useful read: the model can return nulls for
  // everything and still succeed. Recording which fields actually came back is
  // what separates "the pipeline works and the photo was hard" from "the
  // pipeline is broken" — the two things a Phase 3A test has to tell apart.
  trace({
    outcome: 'ok',
    status: response.status,
    kb,
    ms: Date.now() - startedAt,
    name: prefill.name.length > 0,
    date: prefill.expiryDate !== null,
    type: prefill.dateType,
    checks: { name: prefill.needsNameCheck, date: prefill.needsDateCheck },
  });

  return { ok: true, prefill };
}
