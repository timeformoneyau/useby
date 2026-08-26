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
  MODEL_MS_HEADER,
  SCAN_ID_HEADER,
  SERVER_MS_HEADER,
  isScanId,
  newScanId,
  readTimingHeader,
  timingBreakdown,
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

test('the header names are the ones the proxy uses', () => {
  // Cross-repo contract with lib/validate.ts in the proxy. Header lookup is
  // case-insensitive; the spelling is not.
  assert.equal(SCAN_ID_HEADER.toLowerCase(), 'x-useby-scan-id');
  assert.equal(SERVER_MS_HEADER.toLowerCase(), 'x-useby-server-ms');
  assert.equal(MODEL_MS_HEADER.toLowerCase(), 'x-useby-model-ms');
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

/**
 * Timing. The question these exist to answer is "a scan took eight seconds,
 * where did they go" — which is only answerable if the arithmetic is right and
 * the numbers coming back from a separately deployed service are not trusted
 * blindly.
 */

test('a full breakdown accounts for the wait and derives the overhead', () => {
  const out = timingBreakdown({
    totalMs: 4820,
    captureMs: 310,
    resizeMs: 240,
    requestMs: 4210,
    serverMs: 3990,
    modelMs: 3550,
  });
  assert.equal(out.totalMs, 4820);
  assert.equal(out.captureMs, 310);
  assert.equal(out.resizeMs, 240);
  assert.equal(out.requestMs, 4210);
  assert.equal(out.serverMs, 3990);
  assert.equal(out.modelMs, 3550);
  // Everything that is neither the phone nor the proxy: upload, TLS, Vercel
  // routing, the response coming back.
  assert.equal(out.overheadMs, 220);
});

test('clock skew never produces a negative overhead', () => {
  // Two different machines' clocks. A server that claims to have taken longer
  // than the whole round trip is rounding or skew, not a bug worth surfacing as
  // a negative number in a log line.
  const out = timingBreakdown({
    totalMs: 1000, captureMs: 100, resizeMs: 100, requestMs: 700, serverMs: 750,
  });
  assert.equal(out.overheadMs, 0);
});

test('a proxy that reports no timing yields no invented fields', () => {
  // An older deployment, or a failure before the headers were set. Better to
  // say nothing than to report overheadMs equal to the whole round trip.
  const out = timingBreakdown({
    totalMs: 900, captureMs: 100, resizeMs: 80, requestMs: 700,
  });
  assert.equal(out.totalMs, 900);
  assert.equal(out.requestMs, 700);
  assert.ok(!('serverMs' in out), 'no serverMs');
  assert.ok(!('overheadMs' in out), 'no derived overhead without a server figure');
  assert.ok(!('modelMs' in out), 'no modelMs');
});

test('a failure still reports serverMs without a model time', () => {
  // The proxy only knows a model time on a success, but a scan that took eight
  // seconds and then failed is exactly the one worth accounting for.
  const out = timingBreakdown({
    totalMs: 5000, captureMs: 200, resizeMs: 150, requestMs: 4500, serverMs: 4300,
  });
  assert.equal(out.overheadMs, 200);
  assert.ok(!('modelMs' in out));
});

test('timing headers are parsed defensively', () => {
  assert.equal(readTimingHeader('3550'), 3550);
  assert.equal(readTimingHeader('3550.6'), 3551, 'rounded, not left fractional');
  assert.equal(readTimingHeader('0'), 0);

  // Data from a separately deployed service goes into a log line, so anything
  // that is not a plausible millisecond count is dropped rather than recorded.
  assert.equal(readTimingHeader(null), undefined);
  assert.equal(readTimingHeader(''), undefined, 'Number("") is 0 — must not pass');
  assert.equal(readTimingHeader('   '), undefined);
  assert.equal(readTimingHeader('soon'), undefined);
  assert.equal(readTimingHeader('-5'), undefined);
  assert.equal(readTimingHeader('Infinity'), undefined);
  assert.equal(readTimingHeader('NaN'), undefined);
  assert.equal(readTimingHeader(String(3_600_001)), undefined, 'bounded');
});

test('the timing breakdown carries no photo, name or credential', () => {
  const serialised = JSON.stringify(
    timingBreakdown({
      totalMs: 1, captureMs: 1, resizeMs: 1, requestMs: 1, serverMs: 1, modelMs: 1,
    }),
  );
  // Every value is a number. Nothing here can become a place a value leaks into.
  for (const value of Object.values(JSON.parse(serialised))) {
    assert.equal(typeof value, 'number');
  }
});
