/**
 * What the stand-in proxy answers in the CI flow-test build.
 *
 * Each scenario is one thing a real scan can come back with. A flow picks one
 * by opening `useby://e2e?fixture=<name>` before pressing the shutter; the
 * next scan then gets that answer. Dates are relative to the day the test
 * runs, so the list's urgency groups come out the same every day.
 *
 * Pure and dependency-free so `scripts/e2e-scenarios.test.mjs` can check every
 * canned body against the app's real response contract (`readFields`). If the
 * contract moves and these do not, that test fails rather than the flows
 * quietly testing a shape the proxy no longer sends.
 */

/**
 * Present in every module that only the flow-test build may contain. CI greps
 * the production bundle for it and fails if it is there.
 */
export const E2E_MARKER = 'USEBY_E2E_BUILD_7f3c9a';

export const SCENARIOS = [
  'milk',
  'yoghurt',
  'chicken',
  'cheese',
  'unreadable',
  'server-error',
] as const;

export type ScenarioName = (typeof SCENARIOS)[number];

export interface CannedResponse {
  status: number;
  body: unknown;
}

/** Local calendar date `days` from `now`, as YYYY-MM-DD. */
export function isoInDays(days: number, now: Date = new Date()): string {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + days);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

function read(
  name: string,
  days: number,
  dateType: 'use_by' | 'best_before',
  now: Date,
): CannedResponse {
  return {
    status: 200,
    body: {
      ok: true,
      fields: {
        itemName: { value: name, confidence: 'high' },
        expiryDate: { value: isoInDays(days, now), confidence: 'high' },
        dateType: { value: dateType, confidence: 'high' },
      },
    },
  };
}

export function scenarioResponse(name: ScenarioName, now: Date = new Date()): CannedResponse {
  switch (name) {
    case 'milk':
      return read('Milk', 6, 'use_by', now); // Later
    case 'yoghurt':
      return read('Greek yoghurt', 2, 'use_by', now); // Use soon
    case 'chicken':
      return read('Chicken thighs', 0, 'use_by', now); // Today
    case 'cheese':
      return read('Cheddar', -3, 'best_before', now); // Past their date
    case 'unreadable':
      // A successful call where the photo defeated the model.
      return {
        status: 200,
        body: {
          ok: true,
          fields: {
            itemName: { value: null, confidence: 'low' },
            expiryDate: { value: null, confidence: 'low' },
            dateType: { value: 'unknown', confidence: 'low' },
          },
        },
      };
    case 'server-error':
      return { status: 500, body: { ok: false, code: 'upstream_error' } };
  }
}

/** The scenario named by a `useby://e2e?fixture=<name>` link, if any. */
export function scenarioFromUrl(url: string): ScenarioName | null {
  const match = /^useby:\/\/e2e\b.*[?&]fixture=([a-z-]+)/.exec(url);
  const name = match?.[1];
  return SCENARIOS.find((s) => s === name) ?? null;
}

let current: ScenarioName = 'milk';
const listeners = new Set<() => void>();

export function currentScenario(): ScenarioName {
  return current;
}

export function setScenario(name: ScenarioName): void {
  current = name;
  for (const listener of listeners) listener();
}

/**
 * Re-render on a fixture change, so the stand-in camera's label always names
 * the fixture the next shutter will use. A flow waits for that label before
 * pressing the shutter, which is how it knows a `useby://e2e` link has landed
 * while the camera was already open.
 */
export function subscribeScenario(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/*
 * Which answer belongs to which photo.
 *
 * Capture no longer waits for the answer: several scans can be in flight, a
 * scan can wait for a concurrency slot, and the flow may have switched fixture
 * for the next shot before an earlier request goes out. Reading the fixture
 * when the request is answered would hand a scan whatever was picked *last*.
 *
 * So the fixture is fixed at the shutter, in shutter order, and claimed by the
 * scan id the first time a request for that scan arrives. The queue starts
 * requests in shutter order, and a retried request for the same scan id gets
 * the same answer again. Requests with no scan id (the warm-up ping) claim
 * nothing.
 */
const shutterQueue: ScenarioName[] = [];
const claimed = new Map<string, ScenarioName>();

/** Called by the stand-in camera at the moment it takes a picture. */
export function recordShutter(): void {
  shutterQueue.push(current);
}

/** The fixture fixed at this scan's shutter press. */
export function scenarioForScan(scanId: string | undefined): ScenarioName {
  if (!scanId) return current;
  const already = claimed.get(scanId);
  if (already) return already;
  const scenario = shutterQueue.shift() ?? current;
  claimed.set(scanId, scenario);
  return scenario;
}
