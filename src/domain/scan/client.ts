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
 */
const TIMEOUT_MS = 30_000;

export async function scanPhoto(imageBase64: string): Promise<ScanResult> {
  if (!isScanConfigured() || proxySecret === null) {
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
    // Nothing from this branch is logged: the request carries the shared
    // secret in a header, and error objects in some runtimes quote the request
    // back. Distinguishing abort from a transport failure is all we need.
    return scanFailure(
      e instanceof Error && e.name === 'AbortError' ? 'timeout' : 'network',
    );
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) return scanFailure(reasonForStatus(response.status));

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return scanFailure('malformed');
  }

  const fields = readFields(body);
  if (fields === null) return scanFailure('malformed');

  return { ok: true, prefill: toPrefill(fields) };
}
