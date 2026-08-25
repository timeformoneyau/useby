/**
 * Offline guards for the phone's half of the diagnostic trail.
 *
 * The scan id is a cross-repo contract: the proxy validates it against
 * `/^[A-Za-z0-9_-]{1,64}$/` and refuses anything else, minting its own instead.
 * If this app ever produced an id that failed that check, the two log lines
 * would stop matching and nobody would notice until they were trying to
 * diagnose something else. So the shape is pinned on both sides.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SCAN_ID_HEADER,
  isScanId,
  newScanId,
} from '../src/domain/scan/diagnostics.ts';
import { describeRead, mappingDrops, readFields } from '../src/domain/scan/mapping.ts';

const field = (value, confidence = 'high') => ({ value, confidence });
const body = (over = {}) => ({
  ok: true,
  fields: {
    itemName: field('Sausages'),
    expiryDate: field('2026-08-30'),
    dateType: field('use_by'),
    ...over,
  },
});

test('the header name is the one the proxy reads', () => {
  // Cross-repo contract with `SCAN_ID_HEADER` in the proxy's lib/validate.ts.
  assert.equal(SCAN_ID_HEADER.toLowerCase(), 'x-useby-scan-id');
});

test('every generated id is one the proxy will accept', () => {
  // The proxy's exact regex, restated here so this fails if either side drifts.
  const proxyAccepts = /^[A-Za-z0-9_-]{1,64}$/;
  for (let i = 0; i < 500; i++) {
    const id = newScanId();
    assert.match(id, proxyAccepts, id);
    assert.ok(isScanId(id), id);
    assert.ok(id.length <= 64, id);
  }
});

test('ids are distinct within a burst', () => {
  // Two scans in the same millisecond must not share a name, or the log lines
  // for a retry would merge into the one they were meant to be distinguished from.
  const ids = new Set(Array.from({ length: 200 }, newScanId));
  assert.ok(ids.size > 190, `expected near-unique ids, got ${ids.size}/200`);
});

test('an id sorts by time, so "about an hour ago" is a bounded search', () => {
  const early = newScanId();
  const late = `p-${(Date.now() + 60_000).toString(36)}-00000`;
  assert.ok(early < late, `${early} should sort before ${late}`);
});

test('the read classifier names all four outcomes, in the proxy\'s words', () => {
  assert.equal(describeRead(readFields(body())), 'both');
  assert.equal(describeRead(readFields(body({ expiryDate: field(null, 'low') }))), 'name-only');
  assert.equal(describeRead(readFields(body({ itemName: field(null, 'low') }))), 'date-only');
  assert.equal(
    describeRead(
      readFields(body({ itemName: field(null, 'low'), expiryDate: field(null, 'low') })),
    ),
    'neither',
  );
});

test('a clean response is dropped by nothing', () => {
  const parsed = body();
  assert.deepEqual(mappingDrops(parsed, readFields(parsed)), []);
});

test('a value this build refuses is named, so it never reads as a bad photo', () => {
  // The app re-validates what the proxy already normalised, because the two
  // deploy independently. If that guard ever fires it means the deployments
  // disagree — which must not look identical to the model failing to read.
  const impossible = body({ expiryDate: field('2026-02-31') });
  const fields = readFields(impossible);
  assert.equal(fields.expiryDate.value, null, 'still refused — the guard stays');
  assert.deepEqual(mappingDrops(impossible, fields), ['date']);

  const notIso = body({ expiryDate: field('30/08/2026') });
  assert.deepEqual(mappingDrops(notIso, readFields(notIso)), ['date']);
});

test('a field the server never sent is not reported as dropped', () => {
  const missing = body({ expiryDate: field(null, 'low') });
  assert.deepEqual(mappingDrops(missing, readFields(missing)), []);

  const blank = body({ itemName: field('   ') });
  assert.deepEqual(mappingDrops(blank, readFields(blank)), [], 'blank is absent, not dropped');
});

test('drop reporting survives anything the wire might carry', () => {
  assert.deepEqual(mappingDrops(null, null), []);
  assert.deepEqual(mappingDrops('nonsense', null), []);
  assert.deepEqual(mappingDrops({ ok: true }, null), []);
  assert.deepEqual(mappingDrops(body(), null), [], 'no fields means nothing was dropped');
});

test('drop reporting names the field and never its value', () => {
  const parsed = body({ expiryDate: field('2026-02-31') });
  const drops = mappingDrops(parsed, readFields(parsed));
  assert.doesNotMatch(JSON.stringify(drops), /2026/);
  assert.doesNotMatch(JSON.stringify(drops), /Sausages/);
});
