/**
 * Offline guards for the shadow trust gate.
 *
 * Two things are being protected here and they are different in kind.
 *
 * The first is arithmetic: given the characters printed on a pack, does the
 * rule produce the right date, and does it *notice* when the characters do not
 * settle the question? That table is the reason this work exists — `04/09/26`
 * is 4 September here and 9 April in America, both are real dates, both are
 * plausible for groceries, and once the string is normalised away nothing can
 * tell them apart. Every printed form below is a way that could go wrong
 * silently.
 *
 * The second is a property of the whole feature: **the verdict must not change
 * what the user sees.** The last test in this file pins that directly, because
 * the day shadow mode starts steering the editor is the day its numbers stop
 * meaning anything.
 *
 * `today` is fixed at 30 August 2026 throughout, so the year-inference rule and
 * the plausibility window are stated by the test rather than by the calendar.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { classifyDateLabel, parseDateText } from '../src/domain/scan/dateText.ts';
import {
  evaluateRecognitionTrust,
  shadowOutcome,
} from '../src/domain/scan/trust.ts';
import { toPrefill } from '../src/domain/scan/mapping.ts';

const TODAY = new Date(Date.UTC(2026, 7, 30));

/* ---------------------------------------------------------------------------
 * Reading the printed characters.
 * ------------------------------------------------------------------------ */

test('a named month is unambiguous, whatever the spacing', () => {
  for (const text of ['04 SEP 26', '04SEP26', '4 SEP 2026', '04 SEPT 26']) {
    const parsed = parseDateText(text, TODAY);
    assert.equal(parsed.iso, '2026-09-04', text);
    assert.equal(parsed.ambiguous, false, text);
    assert.equal(parsed.yearInferred, false, text);
  }
});

test('label wording swept into the date string does not defeat the parse', () => {
  // The model reports the label separately, so this is belt — but a leading
  // "USE BY" would otherwise make an ordinary date unreadable.
  const parsed = parseDateText('USE BY 15 SEP 26', TODAY);
  assert.equal(parsed.iso, '2026-09-15');
});

test('a numeric date whose parts are both twelve or less is ambiguous', () => {
  // The case the whole module exists for. 4 September day-first, 9 April
  // month-first, and the characters alone do not say which.
  const parsed = parseDateText('04/09/26', TODAY);
  assert.equal(parsed.iso, '2026-09-04', 'day-first, per the local convention');
  assert.equal(parsed.ambiguous, true);
});

test('a numeric date with a day above twelve is not ambiguous', () => {
  for (const text of ['15/09/26', '15-09-2026', '15.09.26']) {
    const parsed = parseDateText(text, TODAY);
    assert.equal(parsed.iso, '2026-09-15', text);
    assert.equal(parsed.ambiguous, false, text);
  }
});

test('a date that only reads month-first is resolved but flagged', () => {
  // 04/15/26 cannot be day-first — there is no fifteenth month — so the pack is
  // not following the local convention. Readable, never trustworthy.
  const parsed = parseDateText('04/15/26', TODAY);
  assert.equal(parsed.iso, '2026-04-15');
  assert.equal(parsed.ambiguous, true);
});

test('the same day and month twice is not ambiguous', () => {
  // 09/09/26 reads identically either way, so there is nothing to be wrong about.
  const parsed = parseDateText('09/09/26', TODAY);
  assert.equal(parsed.iso, '2026-09-09');
  assert.equal(parsed.ambiguous, false);
});

test('an ISO date is taken as printed', () => {
  const parsed = parseDateText('2026-09-04', TODAY);
  assert.equal(parsed.iso, '2026-09-04');
  assert.equal(parsed.format, 'iso');
  assert.equal(parsed.ambiguous, false);
});

test('an impossible date does not resolve', () => {
  for (const text of ['31/02/26', '32/01/26', '00/09/26', '31 FEB 26']) {
    assert.equal(parseDateText(text, TODAY).iso, null, text);
  }
});

test('a missing year is inferred, and says so', () => {
  // 4 September has not passed on 30 August, so this year.
  const soon = parseDateText('04 SEP', TODAY);
  assert.equal(soon.iso, '2026-09-04');
  assert.equal(soon.yearInferred, true);

  // 4 March has passed, so the nearest sensible reading is next year.
  const past = parseDateText('04 MAR', TODAY);
  assert.equal(past.iso, '2027-03-04');
  assert.equal(past.yearInferred, true);
});

test('a month and year with no day does not resolve', () => {
  const parsed = parseDateText('SEP 2026', TODAY);
  assert.equal(parsed.iso, null);
  assert.equal(parsed.dayMissing, true);
});

test('a lone number beside a month could be either a day or a year', () => {
  // "BEST BEFORE SEP 26" — the twenty-sixth of September, or September 2026?
  const parsed = parseDateText('SEP 26', TODAY);
  assert.equal(parsed.iso, null);
  assert.equal(parsed.ambiguous, true);
});

test('two numeric parts leave something to guess', () => {
  const parsed = parseDateText('09/26', TODAY);
  assert.equal(parsed.iso, null);
  assert.equal(parsed.ambiguous, true);
});

test('text that is not a date at all does not resolve', () => {
  for (const text of ['', '   ', 'LOT 4471', 'ABC']) {
    assert.equal(parseDateText(text, TODAY).iso, null, JSON.stringify(text));
  }
});

/* ---------------------------------------------------------------------------
 * Reading the printed wording.
 * ------------------------------------------------------------------------ */

test('only explicit wording earns a classification', () => {
  assert.equal(classifyDateLabel('USE BY'), 'use_by');
  assert.equal(classifyDateLabel('use-by'), 'use_by');
  assert.equal(classifyDateLabel('BEST BEFORE'), 'best_before');
  assert.equal(classifyDateLabel('BEST BEFORE END'), 'best_before');
  assert.equal(classifyDateLabel('BB'), 'best_before');
});

test('EXP and friends stay unknown, and that is deliberate', () => {
  // Not defined terms on Australian food packaging: they do not say whether the
  // date is a safety deadline or a quality one, so calling either would invent
  // a claim the pack never made.
  for (const label of ['EXP', 'EXPIRY', 'EXPIRES', 'SELL BY', 'PACKED ON', 'BAKED ON']) {
    assert.equal(classifyDateLabel(label), 'unknown', label);
  }
});

test('no wording at all is different from wording that means nothing', () => {
  assert.equal(classifyDateLabel(null), null);
  assert.equal(classifyDateLabel('   '), null);
});

/* ---------------------------------------------------------------------------
 * The gate.
 * ------------------------------------------------------------------------ */

/** A scan that should sail through, so each test can spoil exactly one thing. */
const clean = (over = {}) => ({
  itemName: 'Beef mince',
  nameConfidence: 'high',
  expiryDate: '2026-09-15',
  dateConfidence: 'high',
  dateType: 'use_by',
  dateText: '15 SEP 26',
  dateLabelText: 'USE BY',
  otherDateTexts: [],
  ...over,
});

const judge = (over) => evaluateRecognitionTrust(clean(over), TODAY);

test('a clean, corroborated read is the one thing that passes', () => {
  const decision = judge();
  assert.equal(decision.verdict, 'auto_accept');
  assert.deepEqual(decision.blocking, []);
  assert.equal(decision.derived.iso, '2026-09-15');
  assert.equal(decision.derived.dateType, 'use_by');
});

test('no verbatim evidence blocks, however confident the model was', () => {
  // Also the state of every scan until the proxy ships the evidence block: the
  // honest answer is that there was nothing to check, not that it was fine.
  const decision = judge({ dateText: null });
  assert.equal(decision.verdict, 'review');
  assert.ok(decision.blocking.includes('NO_DATE_TEXT'));
});

test('an ambiguous printed date blocks', () => {
  const decision = judge({ dateText: '04/09/26', expiryDate: '2026-09-04' });
  assert.equal(decision.verdict, 'review');
  assert.ok(decision.blocking.includes('AMBIGUOUS_DATE'));
});

test('an inferred year blocks', () => {
  // Guessing the year wrong is a twelve-month error with nothing on the pack to
  // catch it.
  const decision = judge({ dateText: '15 SEP', expiryDate: '2026-09-15' });
  assert.ok(decision.blocking.includes('YEAR_NOT_PRINTED'));
});

test('a month-only date blocks', () => {
  const decision = judge({ dateText: 'SEP 2026', expiryDate: '2026-09-30' });
  assert.ok(decision.blocking.includes('DAY_NOT_PRINTED'));
});

test('characters that do not resolve block', () => {
  const decision = judge({ dateText: 'LOT 4471' });
  assert.ok(decision.blocking.includes('DATE_TEXT_UNPARSEABLE'));
});

test('the two routes disagreeing about the same characters blocks', () => {
  // The cross-check, and the reason the model's own normalised date is still
  // worth having. Here it applied the American reading to an unambiguous
  // day-first string.
  const decision = judge({ dateText: '15 SEP 26', expiryDate: '2026-09-04' });
  assert.equal(decision.verdict, 'review');
  assert.ok(decision.blocking.includes('PARSE_MISMATCH'));
});

test('other dates on the pack with no wording to choose between them blocks', () => {
  // Manufacture date beside an expiry date, and nothing saying which was read.
  const decision = judge({
    dateLabelText: null,
    otherDateTexts: ['01 JAN 26'],
  });
  assert.ok(decision.blocking.includes('MULTIPLE_CANDIDATES'));
});

test('wording that names the date makes a second date on the pack acceptable', () => {
  // "USE BY 15 SEP 26" beside a packed-on date: the choice is evidenced.
  const decision = judge({ otherDateTexts: ['01 JAN 26'] });
  assert.equal(decision.verdict, 'auto_accept');
});

test('a date outside any plausible grocery range blocks', () => {
  const far = judge({ expiryDate: '2062-09-15', dateText: '15 SEP 62' });
  assert.ok(far.blocking.includes('IMPLAUSIBLE_DATE'));

  const old = judge({ expiryDate: '2019-09-15', dateText: '15 SEP 19' });
  assert.ok(old.blocking.includes('IMPLAUSIBLE_DATE'));
});

test('a date passing today or yesterday is still plausible', () => {
  // A use-by that ran out yesterday is a real thing to be holding.
  const today = judge({ expiryDate: '2026-08-30', dateText: '30 AUG 26' });
  assert.equal(today.verdict, 'auto_accept');

  const yesterday = judge({ expiryDate: '2026-08-29', dateText: '29 AUG 26' });
  assert.equal(yesterday.verdict, 'auto_accept');
});

test('anything short of high model confidence on the date blocks', () => {
  for (const confidence of ['medium', 'low']) {
    const decision = judge({ dateConfidence: confidence });
    assert.ok(decision.blocking.includes('LOW_DATE_CONFIDENCE'), confidence);
  }
});

test('high model confidence on its own earns nothing', () => {
  // The veto rule, stated as a test. The model saying it is sure about an
  // ambiguous string does not make the string unambiguous.
  const decision = judge({
    dateText: '04/09/26',
    expiryDate: '2026-09-04',
    dateConfidence: 'high',
    nameConfidence: 'high',
  });
  assert.equal(decision.verdict, 'review');
});

test('a nameless item blocks', () => {
  // It could not be saved as it stands — the editor's Save is disabled without
  // a name — so this is a real blocker rather than a quality concern.
  for (const name of [null, '', '   ']) {
    assert.ok(judge({ itemName: name }).blocking.includes('NO_ITEM_NAME'));
  }
});

test('a scan with neither a name nor a date is failed, not rejected', () => {
  // Distinguished so coverage figures are not polluted by scans that never had
  // a result: a photograph of a bag of onions is not a gate failure.
  const decision = evaluateRecognitionTrust(
    clean({ itemName: null, expiryDate: null, dateText: null }),
    TODAY,
  );
  assert.equal(decision.verdict, 'failed');
});

test('every failed condition is reported, not just the first', () => {
  // The rejection histogram is the output that says where effort would pay, so
  // it needs the whole list.
  const decision = judge({
    dateText: '04/09',
    expiryDate: '2019-01-01',
    dateConfidence: 'low',
    itemName: null,
  });
  for (const reason of ['LOW_DATE_CONFIDENCE', 'NO_ITEM_NAME', 'IMPLAUSIBLE_DATE']) {
    assert.ok(decision.blocking.includes(reason), reason);
  }
  assert.ok(decision.blocking.length >= 4);
});

/* ---------------------------------------------------------------------------
 * Advisory signals: recorded, never blocking.
 * ------------------------------------------------------------------------ */

test('an unlabelled date is advisory, not blocking', () => {
  // Not knowing whether the pack said "use by" or "best before" does not make
  // the date wrong, and the app already presents an unclassified date honestly.
  // Blocking these would cost a large share of coverage to buy no date safety.
  const decision = judge({ dateLabelText: 'EXP' });
  assert.equal(decision.verdict, 'auto_accept');
  assert.ok(decision.advisory.includes('DATE_TYPE_UNKNOWN'));
});

test('wording contradicting the model classification is advisory', () => {
  const decision = judge({ dateLabelText: 'BEST BEFORE', dateType: 'use_by' });
  assert.equal(decision.verdict, 'auto_accept');
  assert.ok(decision.advisory.includes('DATE_TYPE_MISMATCH'));
});

test('a weak or generic name is advisory', () => {
  const weak = judge({ nameConfidence: 'low' });
  assert.equal(weak.verdict, 'auto_accept');
  assert.ok(weak.advisory.includes('LOW_NAME_CONFIDENCE'));

  const generic = judge({ itemName: 'Food' });
  assert.equal(generic.verdict, 'auto_accept');
  assert.ok(generic.advisory.includes('GENERIC_ITEM_NAME'));
});

/* ---------------------------------------------------------------------------
 * Pairing the verdict with what the user actually did.
 * ------------------------------------------------------------------------ */

const values = (over = {}) => ({
  name: 'Beef mince',
  expiryDate: '2026-09-15',
  dateType: 'use_by',
  ...over,
});

test('an untouched save is not a correction', () => {
  const outcome = shadowOutcome('auto_accept', values(), values());
  assert.equal(outcome.dateChanged, false);
  assert.equal(outcome.nameChanged, false);
  assert.equal(outcome.falseAccept, false);
});

test('a corrected date on an auto-accepted scan is the metric', () => {
  const outcome = shadowOutcome(
    'auto_accept',
    values(),
    values({ expiryDate: '2026-09-04' }),
  );
  assert.equal(outcome.dateChanged, true);
  assert.equal(outcome.falseAccept, true, 'the failure the whole exercise measures');
});

test('a corrected date on a scan the gate rejected is not a false accept', () => {
  // The gate did its job. This is the review-capture number, not the error one.
  const outcome = shadowOutcome('review', values(), values({ expiryDate: '2026-09-04' }));
  assert.equal(outcome.dateChanged, true);
  assert.equal(outcome.falseAccept, false);
});

test('typing in a date that was never recognised is not a correction', () => {
  // Folding this into the error rate would inflate it with cases the gate
  // already rejected — no date read is a blocking reason.
  const outcome = shadowOutcome('review', values({ expiryDate: null }), values());
  assert.equal(outcome.dateSupplied, true);
  assert.equal(outcome.dateChanged, false);
  assert.equal(outcome.falseAccept, false);
});

test('a renamed item is recorded separately from a re-dated one', () => {
  // Name errors are real but not dangerous; conflating them with date errors
  // would hide the number that matters behind the one that does not.
  const outcome = shadowOutcome('auto_accept', values(), values({ name: 'Beef mince 500g' }));
  assert.equal(outcome.nameChanged, true);
  assert.equal(outcome.dateChanged, false);
  assert.equal(outcome.falseAccept, false);
});

test('whitespace alone is not a rename', () => {
  const outcome = shadowOutcome('auto_accept', values(), values({ name: '  Beef mince  ' }));
  assert.equal(outcome.nameChanged, false);
});

/* ---------------------------------------------------------------------------
 * The constraint the whole feature depends on.
 * ------------------------------------------------------------------------ */

test('the editor prefill is the same whatever the gate decides', () => {
  // Shadow mode is only shadow mode while this holds. `toPrefill` takes the
  // extracted fields and nothing else — it cannot see a verdict, so it cannot
  // act on one — and these two extractions differ only in ways that change the
  // verdict from auto_accept to review.
  const base = {
    itemName: { value: 'Beef mince', confidence: 'high' },
    expiryDate: { value: '2026-09-15', confidence: 'high' },
    dateType: { value: 'use_by', confidence: 'high' },
  };

  const wouldAccept = {
    ...base,
    observed: { dateText: '15 SEP 26', dateLabelText: 'USE BY', otherDateTexts: [] },
  };
  const wouldReview = {
    ...base,
    observed: { dateText: '04/09/26', dateLabelText: null, otherDateTexts: ['01 JAN 26'] },
  };

  assert.equal(evaluateRecognitionTrust(
    { itemName: 'Beef mince', nameConfidence: 'high', expiryDate: '2026-09-15',
      dateConfidence: 'high', dateType: 'use_by', dateText: '15 SEP 26',
      dateLabelText: 'USE BY', otherDateTexts: [] }, TODAY).verdict, 'auto_accept');
  assert.equal(evaluateRecognitionTrust(
    { itemName: 'Beef mince', nameConfidence: 'high', expiryDate: '2026-09-15',
      dateConfidence: 'high', dateType: 'use_by', dateText: '04/09/26',
      dateLabelText: null, otherDateTexts: ['01 JAN 26'] }, TODAY).verdict, 'review');

  assert.deepEqual(
    toPrefill(wouldAccept),
    toPrefill(wouldReview),
    'the user sees an identical editor either way',
  );
});

test('the prefill still asks for a check exactly as it did before', () => {
  // The pre-existing uncertainty model — a boolean per field, driven by the
  // model's own confidence — is untouched by any of this.
  const fields = {
    itemName: { value: 'Milk', confidence: 'medium' },
    expiryDate: { value: '2026-09-15', confidence: 'high' },
    dateType: { value: 'use_by', confidence: 'high' },
    observed: { dateText: '15 SEP 26', dateLabelText: 'USE BY', otherDateTexts: [] },
  };
  const prefill = toPrefill(fields);
  assert.equal(prefill.needsNameCheck, true);
  assert.equal(prefill.needsDateCheck, false);
});

/* ---------------------------------------------------------------------------
 * Regression: the consumer date-language change must not reach in here.
 *
 * The product now presents a single "Use By" concept and the presentation layer
 * no longer takes a DateType at all. None of that is true of this module. The
 * gate still reasons about what the packaging literally said, because that is
 * evidence — and evidence is exactly the thing a presentation decision has no
 * business simplifying.
 * ------------------------------------------------------------------------ */

test('the gate still tells the packaging labels apart', () => {
  const useBy = judge({ dateLabelText: 'USE BY', dateType: 'use_by' });
  assert.deepEqual(useBy.advisory, [], 'wording and classification agree');
  assert.equal(useBy.derived.dateType, 'use_by');

  const bestBefore = judge({ dateLabelText: 'BEST BEFORE', dateType: 'best_before' });
  assert.deepEqual(bestBefore.advisory, []);
  assert.equal(bestBefore.derived.dateType, 'best_before', 'still recorded as what it was');
});

test('the date-type advisory signals still fire', () => {
  // `DATE_TYPE_UNKNOWN` and `DATE_TYPE_MISMATCH` are part of the evidence the
  // collection run exists to gather. Collapsing the user-facing wording must
  // not quietly retire them.
  assert.ok(judge({ dateLabelText: 'EXP' }).advisory.includes('DATE_TYPE_UNKNOWN'));
  assert.ok(
    judge({ dateLabelText: 'BEST BEFORE', dateType: 'use_by' }).advisory.includes(
      'DATE_TYPE_MISMATCH',
    ),
  );
});

test('a best-before pack is still auto-acceptable on its own evidence', () => {
  // Presenting one concept does not mean judging one concept. The gate cares
  // whether the date is trustworthy, not what the wording was.
  const decision = judge({ dateLabelText: 'BEST BEFORE', dateType: 'best_before' });
  assert.equal(decision.verdict, 'auto_accept');
});

test('verdicts are unchanged by anything in the editing work', () => {
  // A blunt canary. If a later change to items, presentation or editing ever
  // reaches the gate, these three move.
  assert.equal(judge().verdict, 'auto_accept');
  assert.equal(judge({ dateText: '04/09/26', expiryDate: '2026-09-04' }).verdict, 'review');
  assert.equal(
    evaluateRecognitionTrust(
      clean({ itemName: null, expiryDate: null, dateText: null }),
      TODAY,
    ).verdict,
    'failed',
  );
});
