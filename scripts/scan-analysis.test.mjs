/**
 * Offline guards for the scan-analysis harness.
 *
 * Two things are being protected here. The first is the arithmetic: a
 * confidence bound that is quietly wrong is worse than no bound at all,
 * because the whole purpose of this tool is to stop a small clean sample from
 * reading as proof. So the statistics are checked against closed forms and
 * published Clopper-Pearson values rather than merely asserted to be numbers.
 *
 * The second is the accounting. Every scan the harness is given has to come out
 * somewhere — evaluated, excluded with a reason, or counted as malformed — and
 * the tests below walk each of the ways a real device session goes wrong: a
 * truncated logcat buffer, a concatenated export, a scan whose two halves never
 * met, a row nobody wrote ground truth for.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  betaQuantile,
  cleanSampleSizeFor,
  clopperPearsonInterval,
  clopperPearsonUpperBound,
  incompleteBeta,
} from '../tools/scan-analysis/stats.mjs';
import {
  dayDifference,
  isIsoDate,
  joinScans,
  readAnnotations,
  readLogLines,
  loadLogs,
  loadAnnotations,
} from '../tools/scan-analysis/parse.mjs';
import { analyse, DEFAULT_THRESHOLDS } from '../tools/scan-analysis/analyse.mjs';
import { renderReport } from '../tools/scan-analysis/report.mjs';
import { main, parseArgs } from '../tools/scan-analysis/cli.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, '..', 'tools', 'scan-analysis', 'fixtures');
const NOW = new Date('2026-09-02T04:30:00.000Z');

const close = (actual, expected, tolerance = 1e-9) =>
  assert.ok(
    Math.abs(actual - expected) < tolerance,
    `expected ${expected}, got ${actual} (tolerance ${tolerance})`,
  );

// ---------------------------------------------------------------------------
// Builders. A scan is two log lines; the tests only ever vary what matters.
// ---------------------------------------------------------------------------

let counter = 0;
const nextId = () => `p-test${String(++counter).padStart(4, '0')}-aaaa`;

function scanLines(scanId, { outcome = 'ok', read = 'both', type = 'use_by' } = {}) {
  return [
    `09-01 14:00:00.000 1 1 I ReactNativeJS: useby.scan ${JSON.stringify({
      scanId,
      stage: 'capture',
      outcome: 'ok',
      captureMs: 300,
      resizeMs: 240,
      kb: 280,
    })}`,
    `09-01 14:00:05.000 1 1 I ReactNativeJS: useby.scan ${JSON.stringify({
      scanId,
      stage: 'request',
      totalMs: 4800,
      outcome,
      status: 200,
      read,
      type,
      checks: { name: false, date: false },
    })}`,
  ];
}

/** Build a dataset from a compact description, one entry per scan. */
function dataset(specs, thresholds = {}) {
  const lines = [];
  const annotations = [];
  for (const spec of specs) {
    const scanId = spec.scanId ?? nextId();
    lines.push(...scanLines(scanId, spec));
    annotations.push({
      scanId,
      gate: { decision: spec.decision ?? 'accept', reasons: spec.reasons ?? [], origin: 'annotation' },
      proposedDate: spec.proposedDate ?? null,
      truthDate: spec.truthDate ?? null,
      nameCorrect: spec.nameCorrect,
    });
  }
  const { scans, malformed } = (() => {
    const read = readLogLines(lines.join('\n'), 'test');
    return { scans: joinScans(read.entries), malformed: read.malformed };
  })();
  return analyse({ scans, annotations, malformedLogLines: malformed, thresholds, now: NOW });
}

/** N identical, perfectly correct would-be accepts. */
const cleanRun = (n, thresholds = {}) =>
  dataset(
    Array.from({ length: n }, () => ({
      decision: 'accept',
      proposedDate: '2026-09-14',
      truthDate: '2026-09-14',
      nameCorrect: true,
    })),
    thresholds,
  );

// ---------------------------------------------------------------------------
// Statistics, against values that exist independently of this implementation.
// ---------------------------------------------------------------------------

test('the incomplete beta agrees with its closed forms', () => {
  // Beta(1, n) has CDF 1 - (1 - x)^n; Beta(n, 1) has CDF x^n. Both are exact,
  // so any drift in the continued fraction shows up immediately.
  for (const n of [1, 2, 5, 43, 600]) {
    close(incompleteBeta(1, n, 0.25), 1 - Math.pow(0.75, n), 1e-12);
    close(incompleteBeta(n, 1, 0.25), Math.pow(0.25, n), 1e-12);
  }
  // Beta(1/2, 1/2) is the arcsine distribution: I_x = (2/pi) asin(sqrt(x)).
  close(incompleteBeta(0.5, 0.5, 0.3), (2 / Math.PI) * Math.asin(Math.sqrt(0.3)), 1e-10);
  // Symmetry: I_x(a,b) = 1 - I_{1-x}(b,a).
  close(incompleteBeta(3, 7, 0.4), 1 - incompleteBeta(7, 3, 0.6), 1e-12);
});

test('the beta quantile inverts the beta CDF', () => {
  for (const [a, b] of [[1, 10], [3, 7], [5, 5], [1, 598]]) {
    for (const p of [0.025, 0.5, 0.95, 0.975]) {
      close(incompleteBeta(a, b, betaQuantile(p, a, b)), p, 1e-10);
    }
  }
});

test('Clopper-Pearson matches published two-sided intervals', () => {
  // Standard worked examples. 2 of 20 and 1 of 10 appear in every textbook
  // treatment of the exact binomial interval; the values are not ours to choose.
  const twoOfTwenty = clopperPearsonInterval(2, 20, 0.95);
  close(twoOfTwenty.lower, 0.0123, 5e-5);
  close(twoOfTwenty.upper, 0.3170, 5e-5);

  const oneOfTen = clopperPearsonInterval(1, 10, 0.95);
  close(oneOfTen.lower, 0.0025, 5e-5);
  close(oneOfTen.upper, 0.4450, 5e-5);

  // The degenerate ends are exact: 0 of n has lower bound 0, n of n upper 1.
  assert.equal(clopperPearsonInterval(0, 10, 0.95).lower, 0);
  assert.equal(clopperPearsonInterval(10, 10, 0.95).upper, 1);
  close(clopperPearsonInterval(0, 10, 0.95).upper, 1 - Math.pow(0.025, 1 / 10), 1e-12);
  close(clopperPearsonInterval(10, 10, 0.95).lower, Math.pow(0.025, 1 / 10), 1e-12);
});

test('the one-sided upper bound is the exact rule of three', () => {
  // With zero failures the bound collapses to 1 - alpha^(1/n). This is the
  // number the verdict turns on when nothing went wrong, so it is pinned.
  for (const n of [1, 43, 100, 598, 1000]) {
    close(clopperPearsonUpperBound(0, n, 0.95), 1 - Math.pow(0.05, 1 / n), 1e-12);
  }
  close(clopperPearsonUpperBound(0, 43, 0.95), 0.06729675, 1e-7);

  // One-sided is always tighter than the two-sided upper limit at the same
  // nominal level — that is the whole reason for preferring it here.
  assert.ok(clopperPearsonUpperBound(3, 100, 0.95) < clopperPearsonInterval(3, 100, 0.95).upper);

  assert.equal(clopperPearsonUpperBound(0, 0, 0.95), null);
  assert.equal(clopperPearsonUpperBound(5, 5, 0.95), 1);
});

test('the required clean sample size is the inverse of that bound', () => {
  assert.equal(cleanSampleSizeFor(0.005, 0.95), 598);
  assert.equal(cleanSampleSizeFor(0.01, 0.95), 299);
  // The definition holds at the boundary: n scans suffice, n-1 do not.
  const n = cleanSampleSizeFor(0.005, 0.95);
  assert.ok(clopperPearsonUpperBound(0, n, 0.95) <= 0.005);
  assert.ok(clopperPearsonUpperBound(0, n - 1, 0.95) > 0.005);
});

test('date arithmetic crosses months, years and leap days', () => {
  assert.equal(dayDifference('2026-09-10', '2026-10-25'), 45);
  assert.equal(dayDifference('2026-09-20', '2026-09-17'), -3);
  assert.equal(dayDifference('2026-02-28', '2028-02-28'), 730);
  assert.equal(dayDifference('2028-02-28', '2028-03-01'), 2); // 2028 is a leap year
  assert.equal(dayDifference('2026-12-31', '2027-01-01'), 1);
  assert.ok(!isIsoDate('2026-02-30'));
  assert.ok(!isIsoDate('2026-13-01'));
  assert.ok(isIsoDate('2028-02-29'));
});

// ---------------------------------------------------------------------------
// The fifteen dataset cases.
// ---------------------------------------------------------------------------

test('1. a clean correct auto-accept is counted as correct', () => {
  const r = cleanRun(1);
  assert.equal(r.coverage.wouldBeAutoAccepted, 1);
  assert.equal(r.accuracy.scoredAccepts, 1);
  assert.equal(r.accuracy.correctAccepts, 1);
  assert.equal(r.accuracy.falseAccepts, 0);
  assert.equal(r.accuracy.errorDistribution.exact, 1);
  assert.equal(r.falseAcceptRate.observed, 0);
});

test('2. a rejected scan is coverage, not accuracy', () => {
  const r = dataset([
    { decision: 'reject', reasons: ['date-confidence-below-high'], truthDate: '2026-09-14' },
  ]);
  assert.equal(r.coverage.evaluableScans, 1);
  assert.equal(r.coverage.wouldBeAutoAccepted, 0);
  assert.equal(r.coverage.rejected, 1);
  assert.equal(r.coverage.rejectionRate, 1);
  assert.equal(r.coverage.autoAcceptCoverage, 0);
  // A rejection can never be a false accept, however wrong the read was.
  assert.equal(r.accuracy.scoredAccepts, 0);
});

test('3. an incorrect would-be accept is a false accept', () => {
  const r = dataset([
    { decision: 'accept', proposedDate: '2026-09-14', truthDate: '2026-09-14', nameCorrect: true },
    { decision: 'accept', proposedDate: '2026-09-19', truthDate: '2026-09-14', nameCorrect: true },
  ]);
  assert.equal(r.accuracy.falseAccepts, 1);
  assert.equal(r.accuracy.dateIncorrect, 1);
  close(r.falseAcceptRate.observed, 0.5);
  assert.equal(r.incorrectAccepts.length, 1);
  assert.equal(r.incorrectAccepts[0].diffDays, 5);
});

test('3b. a right date under a wrong name is still a false accept', () => {
  // The gate would commit the whole row without review, so the name counts.
  const r = dataset([
    { decision: 'accept', proposedDate: '2026-09-14', truthDate: '2026-09-14', nameCorrect: false },
  ]);
  assert.equal(r.accuracy.dateCorrect, 1);
  assert.equal(r.accuracy.nameIncorrect, 1);
  assert.equal(r.accuracy.falseAccepts, 1);
  assert.equal(r.safetyBar.criteria[0].result, 'FAIL');
});

test('4. a date later than truth is recorded in the dangerous direction', () => {
  const r = dataset([
    { decision: 'accept', proposedDate: '2026-09-19', truthDate: '2026-09-14', nameCorrect: true },
  ]);
  assert.equal(r.accuracy.datesLaterThanTruth, 1);
  assert.equal(r.accuracy.datesEarlierThanTruth, 0);
  assert.equal(r.accuracy.errorDistribution.maxDaysLater, 5);
  assert.equal(r.incorrectAccepts[0].direction, 'later-than-truth');
});

test('5. a date more than 30 days later than truth fails its own criterion', () => {
  const r = dataset([
    { decision: 'accept', proposedDate: '2026-10-25', truthDate: '2026-09-10', nameCorrect: true },
  ]);
  assert.equal(r.dangerousDateErrors.count, 1);
  assert.equal(r.dangerousDateErrors.records[0].diffDays, 45);
  const criterion = r.safetyBar.criteria.find((c) => c.id === 'no-dangerous-late-accepts');
  assert.equal(criterion.result, 'FAIL');
  assert.equal(r.safetyBar.result, 'FAIL');
});

test('5b. exactly 30 days later is not yet dangerous, 31 is', () => {
  // The boundary is worth pinning: the bar says "more than 30 days".
  const at30 = dataset([
    { decision: 'accept', proposedDate: '2026-10-10', truthDate: '2026-09-10', nameCorrect: true },
  ]);
  assert.equal(dayDifference('2026-09-10', '2026-10-10'), 30);
  assert.equal(at30.dangerousDateErrors.count, 0);

  const at31 = dataset([
    { decision: 'accept', proposedDate: '2026-10-11', truthDate: '2026-09-10', nameCorrect: true },
  ]);
  assert.equal(at31.dangerousDateErrors.count, 1);
});

test('6. a date earlier than truth is wrong but not dangerous', () => {
  const r = dataset([
    { decision: 'accept', proposedDate: '2026-08-01', truthDate: '2026-09-14', nameCorrect: true },
  ]);
  assert.equal(r.accuracy.datesEarlierThanTruth, 1);
  assert.equal(r.accuracy.errorDistribution.maxDaysEarlier, 44);
  assert.equal(r.accuracy.errorDistribution.over30Days, 1);
  // Wrong enough to breach the rate, but not a dangerous overshoot.
  assert.equal(r.dangerousDateErrors.count, 0);
  assert.equal(r.safetyBar.criteria[0].result, 'FAIL');
  assert.equal(r.safetyBar.criteria[1].result, 'INSUFFICIENT_EVIDENCE');
});

test('7. a small clean sample is INSUFFICIENT EVIDENCE, not PASS', () => {
  // The case the whole tool exists to prevent: nothing went wrong, and that
  // still is not evidence.
  const r = cleanRun(43);
  assert.equal(r.accuracy.falseAccepts, 0);
  assert.equal(r.falseAcceptRate.observed, 0);
  assert.equal(r.safetyBar.result, 'INSUFFICIENT_EVIDENCE');

  const criterion = r.safetyBar.criteria[0];
  assert.equal(criterion.result, 'INSUFFICIENT_EVIDENCE');
  close(criterion.upperBound, 1 - Math.pow(0.05, 1 / 43), 1e-12);
  assert.match(criterion.reason, /0 errors observed in 43 would-be accepts/);
  assert.match(criterion.reason, /6\.73%/);
  assert.equal(criterion.cleanSampleSizeNeeded, 598);
});

test('8. a large clean sample passes, and the bound is the one that lets it', () => {
  const r = cleanRun(598);
  assert.equal(r.accuracy.scoredAccepts, 598);
  assert.equal(r.accuracy.falseAccepts, 0);
  assert.equal(r.safetyBar.result, 'PASS');
  for (const criterion of r.safetyBar.criteria) assert.equal(criterion.result, 'PASS');
  close(r.falseAcceptRate.confidence.oneSidedUpperBound, 1 - Math.pow(0.05, 1 / 598), 1e-12);
  assert.ok(r.falseAcceptRate.confidence.oneSidedUpperBound <= DEFAULT_THRESHOLDS.maxFalseAcceptRate);

  // One scan fewer and it is not established. The boundary is real, not
  // rounded into existence.
  assert.equal(cleanRun(597).safetyBar.result, 'INSUFFICIENT_EVIDENCE');
});

test('8b. a large sample with one error is judged on the bound, not the point estimate', () => {
  // 1 in 500 is 0.2% observed — comfortably under the 0.5% bar — but the exact
  // one-sided upper bound is 0.95%, so this must not read as PASS. Judging on
  // the point estimate alone is exactly the mistake the tool exists to avoid.
  const specs = Array.from({ length: 500 }, (_, i) => ({
    decision: 'accept',
    proposedDate: i === 0 ? '2026-09-16' : '2026-09-14',
    truthDate: '2026-09-14',
    nameCorrect: true,
  }));
  const r = dataset(specs);
  assert.equal(r.accuracy.falseAccepts, 1);
  close(r.falseAcceptRate.observed, 0.002);
  close(r.falseAcceptRate.confidence.oneSidedUpperBound, 0.0094518, 1e-6);
  assert.ok(r.falseAcceptRate.observed < DEFAULT_THRESHOLDS.maxFalseAcceptRate);
  assert.ok(r.falseAcceptRate.confidence.oneSidedUpperBound > DEFAULT_THRESHOLDS.maxFalseAcceptRate);
  assert.equal(r.safetyBar.result, 'INSUFFICIENT_EVIDENCE');
});

test('9. a threshold breach fails on the observed rate alone', () => {
  const specs = Array.from({ length: 100 }, (_, i) => ({
    decision: 'accept',
    proposedDate: i < 5 ? '2026-09-16' : '2026-09-14',
    truthDate: '2026-09-14',
    nameCorrect: true,
  }));
  const r = dataset(specs);
  close(r.falseAcceptRate.observed, 0.05);
  assert.equal(r.safetyBar.result, 'FAIL');
  assert.match(r.safetyBar.criteria[0].reason, /5\.00%, above the 0\.50% bar/);

  // Thresholds are configuration, not policy baked into the arithmetic.
  const relaxed = dataset(specs, { maxFalseAcceptRate: 0.5 });
  assert.notEqual(relaxed.safetyBar.criteria[0].result, 'FAIL');
});

test('10. a malformed record is counted, never discarded', () => {
  const good = scanLines('p-good0001-aaaa');
  const lines = [
    ...good,
    'I ReactNativeJS: useby.scan {"scanId":"p-trunc001-aaaa","stage":"capture","captureMs":30',
    'I ReactNativeJS: useby.scan ["not","an","object"]',
    'I ReactNativeJS: useby.scan {"stage":"capture","outcome":"ok"}',
    'I ReactNativeJS: useby.scan {"scanId":"p-weird001-aaaa","stage":"teleport"}',
    'I ReactNativeJS: something else entirely, not ours at all',
  ];
  const read = readLogLines(lines.join('\n'), 'test');
  assert.equal(read.entries.length, 2);
  assert.equal(read.malformed.length, 4);
  assert.deepEqual(
    read.malformed.map((m) => m.problem).sort(),
    ['missing-or-invalid-scanId', 'not-an-object', 'unknown-stage', 'unparseable-json'],
  );

  const r = analyse({
    scans: joinScans(read.entries),
    annotations: [],
    malformedLogLines: read.malformed,
    now: NOW,
  });
  assert.equal(r.dataset.malformedLogLines, 4);
  assert.equal(r.dataset.malformedLogLineReasons['unparseable-json'], 1);
  // The one good scan is still analysed; bad neighbours do not poison it.
  assert.equal(r.dataset.totalScansDiscovered, 1);
});

test('11. a scan missing half its join is excluded with the reason why', () => {
  const [capture, request] = scanLines('p-half0001-aaaa');
  const captureOnly = readLogLines(capture, 'test');
  const requestOnly = readLogLines(request, 'test');

  const noRequest = analyse({ scans: joinScans(captureOnly.entries), now: NOW });
  assert.equal(noRequest.dataset.incompleteScans, 1);
  assert.equal(noRequest.dataset.exclusionReasons['no-request-line'], 1);
  assert.equal(noRequest.coverage.evaluableScans, 0);

  const noCapture = analyse({ scans: joinScans(requestOnly.entries), now: NOW });
  assert.equal(noCapture.dataset.exclusionReasons['no-capture-line'], 1);

  // A ground-truth row naming a scan that appears in no log is the other half
  // of the same problem, and is reported rather than counted as a scan.
  const orphan = analyse({
    scans: [],
    annotations: [{ scanId: 'p-ghost001-aaaa', truthDate: '2026-09-14', proposedDate: null, gate: null }],
    now: NOW,
  });
  assert.equal(orphan.dataset.annotationsWithoutMatchingScan, 1);
});

test('12. duplicate records are excluded, not counted twice', () => {
  const lines = [...scanLines('p-dupe0001-aaaa'), ...scanLines('p-dupe0001-aaaa')];
  const read = readLogLines(lines.join('\n'), 'test');
  const scans = joinScans(read.entries);
  assert.equal(scans.length, 1);
  assert.equal(scans[0].duplicates.length, 2);

  const r = analyse({
    scans,
    annotations: [
      {
        scanId: 'p-dupe0001-aaaa',
        gate: { decision: 'accept', reasons: [], origin: 'annotation' },
        proposedDate: '2026-09-14',
        truthDate: '2026-09-14',
      },
    ],
    now: NOW,
  });
  assert.equal(r.dataset.uniqueScanIds, 1);
  assert.equal(r.dataset.duplicateLogLines, 2);
  assert.equal(r.dataset.exclusionReasons['duplicate-log-lines'], 1);
  assert.equal(r.coverage.evaluableScans, 0);

  // Duplicate ground-truth rows for one scan are reported too.
  const notes = readAnnotations(
    JSON.stringify([
      { scanId: 'p-dupe0001-aaaa', truthDate: '2026-09-14' },
      { scanId: 'p-dupe0001-aaaa', truthDate: '2026-09-15' },
    ]),
  );
  assert.equal(notes.records.length, 1);
  assert.equal(notes.duplicates.length, 1);
});

test('13. an accept without ground truth is unscorable, not correct', () => {
  const r = dataset([
    { decision: 'accept', proposedDate: '2026-09-14', truthDate: '2026-09-14', nameCorrect: true },
    { decision: 'accept', proposedDate: '2026-09-14', truthDate: null },
  ]);
  assert.equal(r.coverage.wouldBeAutoAccepted, 2);
  assert.equal(r.accuracy.scoredAccepts, 1);
  assert.equal(r.accuracy.unscorableAccepts, 1);
  assert.equal(r.accuracy.unscorableReasons['no-ground-truth'], 1);
  // The missing one is absent from the denominator rather than assumed good.
  assert.equal(r.falseAcceptRate.denominator, 1);
  assert.equal(r.dataset.scansWithoutGroundTruth, 1);

  // An accept with truth but no proposed date is unscorable for its own reason.
  const noProposal = dataset([
    { decision: 'accept', proposedDate: null, truthDate: '2026-09-14' },
  ]);
  assert.equal(noProposal.accuracy.unscorableReasons['no-proposed-date'], 1);
});

test('14. multiple rejection reasons are preserved, not collapsed', () => {
  const r = dataset([
    { decision: 'reject', reasons: ['item-name-missing', 'date-confidence-below-high'] },
    { decision: 'reject', reasons: ['date-confidence-below-high'] },
    { decision: 'reject', reasons: ['no-fields-read'] },
    { decision: 'reject', reasons: [] },
  ]);
  assert.deepEqual(r.coverage.rejectionReasons, {
    'date-confidence-below-high': 2,
    '(unspecified)': 1,
    'item-name-missing': 1,
    'no-fields-read': 1,
  });
  assert.equal(r.coverage.rejected, 4);
});

test('15. an empty dataset is insufficient evidence, and says so', () => {
  const r = analyse({ now: NOW });
  assert.equal(r.dataset.totalScansDiscovered, 0);
  assert.equal(r.coverage.evaluableScans, 0);
  assert.equal(r.coverage.autoAcceptCoverage, null);
  assert.equal(r.falseAcceptRate.observed, null);
  assert.equal(r.falseAcceptRate.confidence.oneSidedUpperBound, null);
  assert.equal(r.safetyBar.result, 'INSUFFICIENT_EVIDENCE');
  for (const criterion of r.safetyBar.criteria) {
    assert.equal(criterion.result, 'INSUFFICIENT_EVIDENCE');
    assert.ok(criterion.reason.length > 0);
  }
  // It still renders, rather than throwing on a session that collected nothing.
  assert.match(renderReport(r), /No scans were found/);
});

// ---------------------------------------------------------------------------
// Contracts around the edges: conflicts, gate origin, and what must never leak.
// ---------------------------------------------------------------------------

test('the log line\'s own evidence fields reach the failure record', () => {
  // These come from the joined request line rather than the annotations, and
  // they are what turns a row in the failure table back into a scan somebody
  // can go and look at. A join that quietly dropped them would leave every
  // diagnostic field null while every count stayed right, so they are pinned.
  const lines = scanLines('p-evid0001-aaaa', { read: 'date-only', type: 'best_before' });
  const scans = joinScans(readLogLines(lines.join('\n'), 'test').entries);
  const r = analyse({
    scans,
    annotations: [
      {
        scanId: 'p-evid0001-aaaa',
        gate: { decision: 'accept', reasons: [], origin: 'annotation' },
        proposedDate: '2026-09-20',
        truthDate: '2026-09-14',
        nameCorrect: true,
      },
    ],
    now: NOW,
  });
  const [failure] = r.incorrectAccepts;
  assert.equal(failure.scanId, 'p-evid0001-aaaa');
  assert.equal(failure.read, 'date-only');
  assert.equal(failure.dateType, 'best_before');
  assert.deepEqual(failure.checks, { name: false, date: false });
  assert.equal(failure.gateOrigin, 'annotation');
});

test('a gate decision logged by the app wins, and a conflict is not reconciled', () => {
  const lines = [
    `I ReactNativeJS: useby.scan ${JSON.stringify({ scanId: 'p-gate0001-aaaa', stage: 'capture', outcome: 'ok' })}`,
    `I ReactNativeJS: useby.scan ${JSON.stringify({
      scanId: 'p-gate0001-aaaa',
      stage: 'request',
      outcome: 'ok',
      gate: { decision: 'accept', reasons: [] },
    })}`,
  ];
  const scans = joinScans(readLogLines(lines.join('\n'), 'test').entries);

  const agreeing = analyse({
    scans,
    annotations: [
      {
        scanId: 'p-gate0001-aaaa',
        gate: { decision: 'accept', reasons: [], origin: 'annotation' },
        proposedDate: '2026-09-14',
        truthDate: '2026-09-14',
      },
    ],
    now: NOW,
  });
  assert.equal(agreeing.coverage.wouldBeAutoAccepted, 1);
  assert.equal(agreeing.incorrectAccepts.length, 0);

  const conflicting = analyse({
    scans,
    annotations: [
      {
        scanId: 'p-gate0001-aaaa',
        gate: { decision: 'reject', reasons: ['x'], origin: 'annotation' },
        proposedDate: '2026-09-14',
        truthDate: '2026-09-14',
      },
    ],
    now: NOW,
  });
  assert.equal(conflicting.dataset.exclusionReasons['gate-decision-conflict'], 1);
  assert.equal(conflicting.coverage.evaluableScans, 0);
});

test('a scan with no gate decision anywhere is excluded and explained', () => {
  const scans = joinScans(readLogLines(scanLines('p-noga0001-aaaa').join('\n'), 'test').entries);
  const r = analyse({
    scans,
    annotations: [{ scanId: 'p-noga0001-aaaa', truthDate: '2026-09-14', proposedDate: '2026-09-14', gate: null }],
    now: NOW,
  });
  assert.equal(r.dataset.exclusionReasons['no-gate-decision'], 1);
  assert.match(renderReport(r), /carried no gate decision/);
});

test('the annotations reader takes the three shapes and rejects bad rows by name', () => {
  const array = readAnnotations('[{"scanId":"p-aaaa0001-aaaa","truthDate":"2026-09-14"}]');
  assert.equal(array.records.length, 1);

  const enveloped = readAnnotations('{"scans":[{"scanId":"p-aaaa0001-aaaa","truthDate":"2026-09-14"}]}');
  assert.equal(enveloped.records.length, 1);

  const lines = readAnnotations(
    '{"scanId":"p-aaaa0001-aaaa","truthDate":"2026-09-14"}\n{"scanId":"p-aaaa0002-aaaa","truthDate":"2026-09-15"}',
  );
  assert.equal(lines.records.length, 2);

  const bad = readAnnotations(
    JSON.stringify([
      { scanId: 'p-ok000001-aaaa', truthDate: '2026-09-14' },
      { scanId: 'has spaces', truthDate: '2026-09-14' },
      { scanId: 'p-bad00001-aaaa', truthDate: '2026-02-30' },
      { scanId: 'p-bad00002-aaaa', proposedDate: 'soon' },
      { scanId: 'p-bad00003-aaaa', nameCorrect: 'yes' },
      { scanId: 'p-bad00004-aaaa', gate: { decision: 'maybe' } },
      'not an object',
    ]),
  );
  assert.equal(bad.records.length, 1);
  assert.deepEqual(bad.rejected.map((r) => r.problem).sort(), [
    'invalid-gate',
    'invalid-nameCorrect',
    'invalid-proposedDate',
    'invalid-truthDate',
    'missing-or-invalid-scanId',
    'not-an-object',
  ]);
});

test('an item name supplied by mistake is dropped, never carried into the output', () => {
  // The diagnostics avoid item names on purpose. This harness must not become
  // the place they reappear, even if somebody writes one into the file.
  const notes = readAnnotations(
    JSON.stringify([
      {
        scanId: 'p-name0001-aaaa',
        truthDate: '2026-09-14',
        proposedDate: '2026-09-20',
        itemName: 'Chicken thighs',
        truthName: 'Pork loin',
        nameCorrect: false,
        gate: { decision: 'accept', reasons: [] },
      },
    ]),
  );
  assert.equal(notes.records[0].itemName, undefined);
  assert.equal(notes.records[0].truthName, undefined);

  const scans = joinScans(readLogLines(scanLines('p-name0001-aaaa').join('\n'), 'test').entries);
  const r = analyse({ scans, annotations: notes.records, now: NOW });
  const serialised = JSON.stringify(r) + renderReport(r);
  assert.ok(!serialised.includes('Chicken'), 'item name leaked into the output');
  assert.ok(!serialised.includes('Pork'), 'item name leaked into the output');
  // The measurement it was supplied for still lands.
  assert.equal(r.accuracy.nameIncorrect, 1);
});

test('the same input twice produces byte-identical output', () => {
  const run = () =>
    JSON.stringify(
      analyse({
        scans: loadLogs([join(FIXTURES, 'session.log')]).scans,
        annotations: loadAnnotations(join(FIXTURES, 'ground-truth.json')).records,
        now: NOW,
      }),
    );
  assert.equal(run(), run());
});

// ---------------------------------------------------------------------------
// End to end, over the checked-in fixtures.
// ---------------------------------------------------------------------------

test('the fixture session analyses to the counts it was built to produce', () => {
  const logs = loadLogs([join(FIXTURES, 'session.log')]);
  const notes = loadAnnotations(join(FIXTURES, 'ground-truth.json'));
  assert.equal(notes.rejected.length, 0, 'the fixture ground truth should itself be valid');

  const r = analyse({
    scans: logs.scans,
    annotations: notes.records,
    malformedLogLines: logs.malformed,
    rejectedAnnotations: notes.rejected,
    duplicateAnnotations: notes.duplicates,
    now: NOW,
  });

  assert.equal(r.dataset.totalScansDiscovered, 13);
  assert.equal(r.dataset.malformedLogLines, 1);
  assert.equal(r.dataset.scansWithDuplicateLines, 1);
  assert.equal(r.dataset.incompleteScans, 2);
  assert.equal(r.dataset.excludedScans, 3);

  assert.equal(r.coverage.evaluableScans, 10);
  assert.equal(r.coverage.wouldBeAutoAccepted, 7);
  assert.equal(r.coverage.rejected, 3);
  close(r.coverage.autoAcceptCoverage, 0.7);

  assert.equal(r.accuracy.scoredAccepts, 6);
  assert.equal(r.accuracy.falseAccepts, 4);
  assert.equal(r.accuracy.datesLaterThanTruth, 2);
  assert.equal(r.accuracy.datesEarlierThanTruth, 1);
  assert.equal(r.accuracy.nameIncorrect, 1);

  assert.equal(r.dangerousDateErrors.count, 1);
  assert.equal(r.dangerousDateErrors.records[0].scanId, 'p-mfk2a005-0005e');
  assert.equal(r.dangerousDateErrors.records[0].diffDays, 45);
  assert.equal(r.safetyBar.result, 'FAIL');
});

test('the CLI writes both outputs and reports the verdict through its exit code', async () => {
  const { mkdtempSync, readFileSync: read } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const out = mkdtempSync(join(tmpdir(), 'useby-analysis-'));
  const jsonPath = join(out, 'result.json');
  const mdPath = join(out, 'report.md');

  const said = [];
  const io = { log: (m) => said.push(m), error: (m) => said.push(m) };

  const code = main(
    [
      join(FIXTURES, 'session.log'),
      '--ground-truth', join(FIXTURES, 'ground-truth.json'),
      '--json', jsonPath,
      '--markdown', mdPath,
      '--now', NOW.toISOString(),
    ],
    io,
  );
  assert.equal(code, 0);

  const parsed = JSON.parse(read(jsonPath, 'utf8'));
  assert.equal(parsed.schemaVersion, '1.0.0');
  assert.equal(parsed.tool, 'useby-scan-analysis');
  assert.equal(parsed.analysedAt, NOW.toISOString());
  assert.equal(parsed.safetyBar.result, 'FAIL');
  assert.equal(parsed.thresholds.maxFalseAcceptRate, 0.005);
  assert.equal(parsed.inputs.groundTruthPath, join(FIXTURES, 'ground-truth.json'));

  const markdown = read(mdPath, 'utf8');
  assert.match(markdown, /\*\*Verdict: FAIL\*\*/);
  assert.match(markdown, /does not authorise turning exception-based review on/);
  assert.match(markdown, /p-mfk2a005-0005e/);

  // --strict turns the verdict into an exit code for later CI use.
  assert.equal(
    main([join(FIXTURES, 'session.log'), '--ground-truth', join(FIXTURES, 'ground-truth.json'), '--strict', '--quiet'], io),
    2,
  );
});

test('the CLI refuses bad invocations rather than analysing nothing', () => {
  const said = [];
  const io = { log: (m) => said.push(String(m)), error: (m) => said.push(String(m)) };

  assert.equal(main([], io), 1);
  assert.equal(main(['--nonsense', 'x'], io), 1);
  assert.equal(main(['logs', '--confidence'], io), 1);
  assert.equal(main(['logs', '--max-false-accept-rate', 'lots'], io), 1);
  assert.equal(main(['/no/such/path/at/all'], io), 1);
  assert.equal(main(['--help'], io), 0);

  assert.deepEqual(parseArgs(['a', 'b', '--strict']).logPaths, ['a', 'b']);
  assert.equal(parseArgs(['a', '--confidence', '0.99']).thresholds.confidence, 0.99);
});
