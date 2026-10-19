/**
 * Test-mode setup for the CI flow-test build. metro.config.js substitutes this
 * for `src/testing/e2eHook.ts` when USEBY_E2E=1; every other build gets the
 * empty hook and none of this code.
 *
 * Two things happen here:
 *
 * 1. Requests to the stub proxy origin are answered from `scenarios.ts`, so
 *    the real scan client, its headers, timeout handling and response mapping
 *    all run, but nothing reaches the real proxy or Claude. Flow tests cost
 *    nothing per run and do not depend on what the model reads.
 * 2. `useby://e2e?fixture=<name>` links pick which answer the next scan gets.
 */
import { Linking } from 'react-native';
import { parseExpiryUrl } from '../../src/config/proxy';
import { SCAN_ID_HEADER } from '../../src/domain/scan/diagnostics';
import {
  E2E_MARKER,
  currentScenario,
  scenarioFromUrl,
  scenarioResponse,
  setScenario,
} from './scenarios';

const STUB_ORIGIN = 'https://e2e.invalid';

// Fail loudly rather than let a misconfigured test build talk to the real
// proxy and spend real money on every CI run.
if (!parseExpiryUrl.startsWith(STUB_ORIGIN)) {
  throw new Error(`${E2E_MARKER}: proxy URL is not the e2e stub (${parseExpiryUrl})`);
}

/** Long enough that the reading screen is genuinely shown, as on a phone. */
const STUB_LATENCY_MS = 700;

const realFetch = globalThis.fetch;

globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (!url.startsWith(STUB_ORIGIN)) return realFetch(input, init);

  await new Promise((resolve) => setTimeout(resolve, STUB_LATENCY_MS));
  const sentHeaders = (init?.headers ?? {}) as Record<string, string>;
  const { status, body } = scenarioResponse(currentScenario());
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      [SCAN_ID_HEADER]: sentHeaders[SCAN_ID_HEADER] ?? '',
    },
  });
};

function applyLink(url: string | null) {
  const scenario = url ? scenarioFromUrl(url) : null;
  if (scenario) setScenario(scenario);
}

Linking.getInitialURL().then(applyLink, () => {});
Linking.addEventListener('url', ({ url }) => applyLink(url));

console.log(`${E2E_MARKER} test mode active`);
