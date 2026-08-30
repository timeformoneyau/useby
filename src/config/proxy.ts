/**
 * Configuration for the deployed parse-expiry proxy.
 *
 * Both values arrive as `EXPO_PUBLIC_` environment variables, which Expo
 * inlines into the JS bundle at build time. That prefix is deliberate rather
 * than incidental: Expo's own contract for `EXPO_PUBLIC_` is "this value ships
 * inside the app and is readable by anyone holding the binary". That is
 * precisely what `MOBILE_APP_SECRET` is — see D4 on the Build Plan. Storing it
 * under a name that implied confidentiality would misrepresent a guarantee the
 * mechanism cannot make.
 *
 * What the secret is for: stopping a deployment sitting open to anyone who
 * guesses the URL and quietly running up the Anthropic bill. It is a
 * deployment guard, not authentication. It does not identify a user, cannot be
 * revoked per device, and rotating it means shipping a new build. When real
 * per-user sessions exist it is replaced — not supplemented — by a validated
 * session token.
 *
 * Neither value is committed. Locally they come from `.env` (gitignored, see
 * `.env.example`); on EAS they come from that profile's environment variables.
 * The references below must stay as literal `process.env.EXPO_PUBLIC_*` reads:
 * Expo substitutes them textually at build time, so a computed key would
 * silently resolve to undefined.
 */

/**
 * Where the proxy lives when nothing overrides it. Kept here as the single
 * definition rather than inline at the call site, so pointing the app at a
 * preview deployment is a config change and not a code edit.
 */
const DEFAULT_PROXY_ORIGIN = 'https://usebyproxy.vercel.app';

const PARSE_EXPIRY_PATH = '/api/parse-expiry';

function resolveOrigin(): string {
  const configured = process.env.EXPO_PUBLIC_USEBY_PROXY_URL?.trim();
  const origin = configured || DEFAULT_PROXY_ORIGIN;
  // A trailing slash would produce `//api/parse-expiry`, which Vercel serves
  // as a redirect rather than the route.
  return origin.replace(/\/+$/, '');
}

/** Full URL of the extraction endpoint. */
export const parseExpiryUrl = `${resolveOrigin()}${PARSE_EXPIRY_PATH}`;

/**
 * The shared deployment guard, or null when the build was made without one.
 * Null is a legitimate state: the app still runs, scanning is simply
 * unavailable and the user goes straight to manual entry.
 */
export const proxySecret: string | null =
  process.env.EXPO_PUBLIC_USEBY_PROXY_SECRET?.trim() || null;

/** True when this build can reach the proxy at all. */
export function isScanConfigured(): boolean {
  return proxySecret !== null;
}

/**
 * Wake the proxy up before there is a photo waiting on it.
 *
 * The scan endpoint is a serverless function: the first request of a session
 * pays for starting a Node runtime that has since been reclaimed, and that cost
 * lands on the first thing someone photographs. Opening the camera is a good
 * predictor that a scan is seconds away, so the wait can be spent then instead.
 *
 * Fire and forget in the strictest sense — nothing is awaited, nothing is
 * reported, and every failure is swallowed. It is an optimisation with no
 * correctness role whatsoever: if it fails, or the runtime goes cold again
 * before the shutter, the scan behaves exactly as it does today.
 *
 * A `GET` because the endpoint already answers one (with a `405`, which is the
 * point — it is the cheapest thing that loads the route). Note that the proxy
 * logs that `405` as an error line, so these appear in its log; making the
 * endpoint answer a warm ping quietly is a proxy-side follow-up.
 *
 * Deliberately not sent when scanning is unconfigured: there would be nothing
 * to warm up for.
 */
export function warmProxy(): void {
  if (!isScanConfigured()) return;

  try {
    void fetch(parseExpiryUrl, { method: 'GET' }).catch(() => {});
  } catch {
    // Some runtimes throw synchronously on a malformed URL. Same answer.
  }
}
