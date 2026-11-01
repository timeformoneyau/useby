/**
 * The flow-test build's canned proxy answers must match the real contract.
 *
 * They run through the app's own `readFields` / `toPrefill` here, so if the
 * contract changes and the canned bodies do not, this fails in seconds instead
 * of the emulator flows testing a response the proxy no longer sends.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readFields, reasonForStatus, toPrefill } from '../src/domain/scan/mapping.ts';
import {
  SCENARIOS,
  isoInDays,
  scenarioFromUrl,
  scenarioResponse,
} from '../e2e/app/scenarios.ts';

const NOW = new Date(2026, 9, 19, 10, 0); // 19 Oct 2026, local time

test('every successful scenario passes the real response contract', () => {
  for (const name of SCENARIOS) {
    const { status, body } = scenarioResponse(name, NOW);
    if (status !== 200) continue;
    assert.notEqual(readFields(body), null, `${name} must satisfy readFields`);
  }
});

test('the four item scenarios prefill a name and a date', () => {
  const expected = {
    milk: ['Milk', '2026-10-25'],
    yoghurt: ['Greek yoghurt', '2026-10-21'],
    chicken: ['Chicken thighs', '2026-10-19'],
    cheese: ['Cheddar', '2026-10-16'],
  };
  for (const [name, [item, date]] of Object.entries(expected)) {
    const prefill = toPrefill(readFields(scenarioResponse(name, NOW).body));
    assert.equal(prefill.name, item);
    assert.equal(prefill.expiryDate, date);
    assert.equal(prefill.needsNameCheck, false);
    assert.equal(prefill.needsDateCheck, false);
  }
});

test('unreadable is a 200 with nothing read', () => {
  const prefill = toPrefill(readFields(scenarioResponse('unreadable', NOW).body));
  assert.equal(prefill.name, '');
  assert.equal(prefill.expiryDate, null);
});

test('server-error maps to the server failure', () => {
  assert.equal(reasonForStatus(scenarioResponse('server-error', NOW).status), 'server');
});

test('isoInDays crosses month ends in local time', () => {
  assert.equal(isoInDays(13, NOW), '2026-11-01');
  assert.equal(isoInDays(-19, NOW), '2026-09-30');
});

test('scenario links', () => {
  assert.equal(scenarioFromUrl('useby://e2e?fixture=cheese'), 'cheese');
  assert.equal(scenarioFromUrl('useby://e2e?x=1&fixture=server-error'), 'server-error');
  assert.equal(scenarioFromUrl('useby://e2e?fixture=caviar'), null);
  assert.equal(scenarioFromUrl('useby://other?fixture=milk'), null);
});
