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

export function currentScenario(): ScenarioName {
  return current;
}

export function setScenario(name: ScenarioName): void {
  current = name;
}
