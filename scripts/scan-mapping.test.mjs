/**
 * Offline guards for the proxy-response → editor-prefill translation.
 *
 * No network, no API key, no React Native — `mapping.ts` imports only types,
 * which Node's type stripping erases, so it loads directly here. These cover
 * the boundary where a bad extraction could otherwise reach the user as a
 * confident-looking wrong answer.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DATE_TYPES,
  emptyPrefill,
  failureMessage,
  isIsoDate,
  normaliseDateType,
  readFields,
  reasonForStatus,
  reviewCopy,
  toPrefill,
} from '../src/domain/scan/mapping.ts';

const field = (value, confidence = 'high') => ({ value, confidence });

const body = (over = {}) => ({
  ok: true,
  fields: {
    itemName: field('Milk'),
    expiryDate: field('2026-08-27'),
    dateType: field('use_by'),
    ...over,
  },
});

test('reads a clean extraction', () => {
  const fields = readFields(body());
  assert.deepEqual(fields.itemName, { value: 'Milk', confidence: 'high' });
  assert.deepEqual(fields.expiryDate, { value: '2026-08-27', confidence: 'high' });
  assert.deepEqual(fields.dateType, { value: 'use_by', confidence: 'high' });
});

test('a clean extraction flags nothing for checking', () => {
  const prefill = toPrefill(readFields(body()));
  assert.equal(prefill.name, 'Milk');
  assert.equal(prefill.expiryDate, '2026-08-27');
  assert.equal(prefill.dateType, 'use_by');
  assert.equal(prefill.needsNameCheck, false);
  assert.equal(prefill.needsDateCheck, false);
  assert.equal(prefill.source, 'photo');
});

test('D1: an ambiguous label keeps its date and stays unknown', () => {
  const fields = readFields(
    body({ dateType: field('unknown', 'low'), expiryDate: field('2026-09-02') }),
  );
  const prefill = toPrefill(fields);
  assert.equal(prefill.dateType, 'unknown');
  // The whole point of D1: classifying ambiguously must never cost the date.
  assert.equal(prefill.expiryDate, '2026-09-02');
  assert.equal(prefill.needsDateCheck, false);
});

test('best_before survives the round trip', () => {
  const prefill = toPrefill(readFields(body({ dateType: field('best_before') })));
  assert.equal(prefill.dateType, 'best_before');
});

test('an unrecognised dateType degrades to unknown, never to a claim', () => {
  assert.equal(normaliseDateType('expiry'), 'unknown');
  assert.equal(normaliseDateType(null), 'unknown');
  assert.equal(normaliseDateType(undefined), 'unknown');
  assert.equal(normaliseDateType(42), 'unknown');
  for (const value of DATE_TYPES) assert.equal(normaliseDateType(value), value);
});

test('anything short of high confidence asks for a look', () => {
  const medium = toPrefill(readFields(body({ expiryDate: field('2026-08-27', 'medium') })));
  assert.equal(medium.needsDateCheck, true);
  assert.equal(medium.expiryDate, '2026-08-27', 'the date is still offered, just flagged');

  const low = toPrefill(readFields(body({ itemName: field('Mlk', 'low') })));
  assert.equal(low.needsNameCheck, true);
  assert.equal(low.name, 'Mlk');
});

test('a missing date is a valid state, not a failure', () => {
  const prefill = toPrefill(readFields(body({ expiryDate: field(null, 'low') })));
  assert.equal(prefill.expiryDate, null);
  assert.equal(prefill.needsDateCheck, true);
  assert.equal(prefill.name, 'Milk', 'the half that was read is still kept');
});

test('a missing name is a valid state, not a failure', () => {
  const prefill = toPrefill(readFields(body({ itemName: field(null, 'low') })));
  assert.equal(prefill.name, '');
  assert.equal(prefill.needsNameCheck, true);
  assert.equal(prefill.expiryDate, '2026-08-27');
});

test('an impossible date is dropped rather than shown', () => {
  const fields = readFields(body({ expiryDate: field('2026-02-31') }));
  assert.equal(fields.expiryDate.value, null);
  assert.equal(toPrefill(fields).needsDateCheck, true);
});

test('a non-ISO date is dropped', () => {
  assert.equal(readFields(body({ expiryDate: field('27/08/2026') })).expiryDate.value, null);
  assert.equal(readFields(body({ expiryDate: field('soon') })).expiryDate.value, null);
});

test('isIsoDate accepts real dates and rejects impossible ones', () => {
  assert.equal(isIsoDate('2026-08-27'), true);
  assert.equal(isIsoDate('2028-02-29'), true, 'leap year');
  assert.equal(isIsoDate('2026-02-29'), false, 'not a leap year');
  assert.equal(isIsoDate('2026-13-01'), false);
  assert.equal(isIsoDate('2026-00-10'), false);
  assert.equal(isIsoDate('26-08-27'), false);
});

test('whitespace-only text counts as absent', () => {
  const fields = readFields(body({ itemName: field('   ') }));
  assert.equal(fields.itemName.value, null);
});

test('an unreadable confidence is treated as the least certain', () => {
  const fields = readFields(body({ itemName: field('Milk', 'very sure') }));
  assert.equal(fields.itemName.confidence, 'low');
  assert.equal(toPrefill(fields).needsNameCheck, true);
});

test('a body that does not match the contract is rejected outright', () => {
  assert.equal(readFields(null), null);
  assert.equal(readFields('nope'), null);
  assert.equal(readFields({ ok: false, error: 'boom' }), null);
  assert.equal(readFields({ ok: true }), null);
  assert.equal(readFields({ ok: true, fields: {} }), null);
  assert.equal(readFields({ ok: true, fields: { itemName: field('Milk') } }), null);
});

test('HTTP statuses map to the failure the user should hear about', () => {
  assert.equal(reasonForStatus(401), 'unauthorized');
  assert.equal(reasonForStatus(413), 'too-large');
  assert.equal(reasonForStatus(400), 'rejected');
  assert.equal(reasonForStatus(405), 'rejected');
  assert.equal(reasonForStatus(502), 'unreadable');
  assert.equal(reasonForStatus(500), 'server');
  assert.equal(reasonForStatus(503), 'server');
});

test('every failure has copy, and none of it leaks server internals', () => {
  const reasons = [
    'not-configured', 'timeout', 'network', 'unauthorized',
    'rejected', 'too-large', 'server', 'unreadable', 'malformed',
  ];
  for (const reason of reasons) {
    const message = failureMessage(reason);
    assert.equal(typeof message, 'string');
    assert.ok(message.length > 0, `${reason} has copy`);
    assert.doesNotMatch(message, /\b(4\d\d|5\d\d)\b/, `${reason} names no status code`);
  }
});

test('a failed scan still opens the editor with a usable manual path', () => {
  const prefill = emptyPrefill('photo', failureMessage('unreadable'));
  assert.equal(prefill.name, '');
  assert.equal(prefill.expiryDate, null);
  assert.equal(prefill.dateType, 'unknown');
  assert.equal(prefill.needsNameCheck, false, 'nothing was read, so nothing is flagged as doubtful');
  assert.equal(prefill.needsDateCheck, false);
  assert.ok(prefill.notice.includes('type it in'));
});

test('manual entry starts clean, with no scan artefacts', () => {
  const prefill = emptyPrefill('manual');
  assert.equal(prefill.source, 'manual');
  assert.equal(prefill.notice, undefined);
  assert.equal(prefill.dateType, 'unknown');
});

/**
 * The five outcomes a Phase 3A test has to be able to tell apart.
 *
 * Everything above covers them one field at a time. These cover them as whole
 * arrivals at the editor, because that is where they are indistinguishable to
 * the person holding the phone — and where one of them was, until now, being
 * described as something it was not.
 */

test('a useful read arrives with both fields and nothing flagged', () => {
  const prefill = toPrefill(readFields(body()));
  assert.deepEqual(reviewCopy('photo', false, true, true), {
    title: "Here's what we found",
    note: 'Have a quick look, then save.',
  });
  assert.equal(prefill.name, 'Milk');
  assert.equal(prefill.expiryDate, '2026-08-27');
  assert.equal(prefill.needsNameCheck, false);
  assert.equal(prefill.needsDateCheck, false);
});

test('a partial read says which half it got, and gets it the right way round', () => {
  const noDate = toPrefill(readFields(body({ expiryDate: field(null, 'low') })));
  assert.match(
    reviewCopy('photo', false, Boolean(noDate.name), noDate.expiryDate !== null).note,
    /item but not the date/,
  );

  const noName = toPrefill(readFields(body({ itemName: field(null, 'low') })));
  assert.match(
    reviewCopy('photo', false, Boolean(noName.name), noName.expiryDate !== null).note,
    /date but not the item/,
  );
});

test('a 200 that read nothing is not described as a partial success', () => {
  // Regression guard. The model returning nulls for everything is a well-formed
  // success, and it used to fall through to "We got the date but not the item"
  // on a screen showing no date — the model claiming a read it never made,
  // which is the one thing this whole pipeline is built to avoid.
  const prefill = toPrefill(
    readFields(body({ itemName: field(null, 'low'), expiryDate: field(null, 'low') })),
  );
  assert.equal(prefill.name, '');
  assert.equal(prefill.expiryDate, null);

  const copy = reviewCopy('photo', false, Boolean(prefill.name), prefill.expiryDate !== null);
  assert.equal(copy.title, "We couldn't read that one");
  assert.doesNotMatch(copy.note, /we got/i);
});

test('an outright failure and an empty read read the same to the user', () => {
  // They are the same situation: nothing was extracted. The difference is
  // whether the request completed, which belongs in the log, not on the screen.
  const failed = reviewCopy('photo', true, false, false);
  const empty = reviewCopy('photo', false, false, false);
  assert.deepEqual(failed, empty);
});

test('malformed output never reaches the editor as a partial read', () => {
  // Each of these is a shape the proxy should never send. None may resolve to
  // a prefill: a half-parsed contract is how a hallucinated value gets in.
  const malformed = [
    { ok: true, fields: { itemName: field('Milk'), expiryDate: field('2026-08-27') } },
    { ok: true, fields: { itemName: field('Milk'), dateType: field('use_by') } },
    { ok: 'yes', fields: body().fields },
    { fields: body().fields },
  ];
  for (const candidate of malformed) {
    assert.equal(readFields(candidate), null, JSON.stringify(candidate));
  }
});

test('an upstream failure does not tell the user to retake the photo', () => {
  // The proxy answers 503 when Anthropic is unreachable or throttling and 500
  // when its own configuration is wrong. Neither is the photo's fault, and
  // neither may inherit the "try a clearer photo" copy that 502 carries.
  for (const status of [500, 503]) {
    const reason = reasonForStatus(status);
    assert.equal(reason, 'server');
    assert.doesNotMatch(failureMessage(reason), /photo/i);
  }
  assert.match(failureMessage(reasonForStatus(502)), /clearer photo/i);
});

test('manual entry is never given scan-review copy', () => {
  assert.equal(reviewCopy('manual', false, false, false).title, 'Add an item');
  // Even carrying a notice, which manual entry never does — the source wins.
  assert.equal(reviewCopy('manual', true, true, true).title, 'Add an item');
});
