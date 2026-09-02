/**
 * The analysis itself: scans in, verdict out.
 *
 * Pure. It takes already-parsed records and returns a plain object; it reads no
 * files, writes nothing, and consults no clock it was not handed. That is what
 * makes it testable against fixtures and what makes two runs over the same data
 * produce the same bytes.
 *
 * The shape of the answer is driven by one asymmetry. A date read as *earlier*
 * than the truth makes someone throw out food that was still good. A date read
 * as *later* makes them eat something that was not. Those are not the same
 * failure and a mean absolute error would average them into a single number
 * that hides the only one that matters — so the signed direction is carried all
 * the way through to the verdict, and "more than 30 days later than truth" is a
 * criterion in its own right rather than a tail of a distribution.
 */

import { clopperPearsonInterval, clopperPearsonUpperBound, cleanSampleSizeFor } from './stats.mjs';
import { dayDifference, readGate } from './parse.mjs';

export const TOOL = 'useby-scan-analysis';
export const TOOL_VERSION = '1.0.0';
export const SCHEMA_VERSION = '1.0.0';

/**
 * The proposed bar, as configuration rather than as policy.
 *
 * These are the numbers currently under discussion, not a decision the product
 * has taken. They live here so the analysis can be re-run against a different
 * bar without touching the arithmetic, and so that the report can print what it
 * was actually judged against.
 */
export const DEFAULT_THRESHOLDS = {
  /** False auto-accepts as a fraction of would-be auto-accepts. 1 in 200. */
  maxFalseAcceptRate: 0.005,
  /** Days later than truth at which an accepted date stops being a near miss. */
  dangerousLaterDays: 30,
  /**
   * The rate the "zero dangerous accepts" criterion must be shown to be under.
   *
   * Observing none is necessary but cannot be sufficient: zero in twelve is
   * zero in twelve. The criterion therefore also has to clear a statistical
   * bound, or a tiny clean sample would pass a rule stated as "never".
   */
  maxDangerousAcceptRate: 0.005,
  /** Confidence level for every bound reported. One-sided where it decides. */
  confidence: 0.95,
};

/** Why a scan took no part in the evaluation. Each scan gets exactly one. */
export const EXCLUSIONS = {
  DUPLICATE: 'duplicate-log-lines',
  UNJOINED_NO_REQUEST: 'no-request-line',
  UNJOINED_NO_CAPTURE: 'no-capture-line',
  GATE_CONFLICT: 'gate-decision-conflict',
  PROPOSAL_CONFLICT: 'proposed-date-conflict',
  NO_GATE: 'no-gate-decision',
};

/** Why a would-be accept could not be scored for accuracy. */
export const UNSCORABLE = {
  NO_GROUND_TRUTH: 'no-ground-truth',
  NO_PROPOSED_DATE: 'no-proposed-date',
};

function tally(list) {
  const counts = {};
  for (const key of list) counts[key] = (counts[key] ?? 0) + 1;
  // Sorted by count then name so the histogram is stable across runs.
  return Object.fromEntries(
    Object.entries(counts).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)),
  );
}

function rate(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : null;
}

/**
 * Decide what one scan contributes, given its log record and its annotation.
 *
 * Where both sources carry the same field the log wins and the disagreement is
 * recorded — never quietly reconciled. A log line and a hand-written note
 * disagreeing about what the gate decided means one of them is wrong about the
 * run, and averaging over that would launder a bookkeeping error into a
 * measurement.
 */
export function resolveScan(scan, annotation) {
  const request = scan?.request?.entry ?? null;

  const logGate = request ? readGate(request) : null;
  const noteGate = annotation?.gate ?? null;
  const gateConflict =
    logGate !== null && noteGate !== null && logGate.decision !== noteGate.decision;
  const gate = logGate ?? noteGate;

  const logProposed = typeof request?.proposedDate === 'string' ? request.proposedDate : null;
  const noteProposed = annotation?.proposedDate ?? null;
  const proposedConflict =
    logProposed !== null && noteProposed !== null && logProposed !== noteProposed;
  const proposedDate = logProposed ?? noteProposed;

  return {
    scanId: scan.scanId,
    outcome: request?.outcome ?? scan?.capture?.entry?.outcome ?? null,
    read: request?.read ?? null,
    dateType: request?.type ?? null,
    checks: request?.checks ?? null,
    gate,
    gateConflict,
    proposedDate,
    proposedConflict,
    truthDate: annotation?.truthDate ?? null,
    nameCorrect: annotation?.nameCorrect,
    duplicates: scan.duplicates ?? [],
    hasCapture: scan.capture !== null,
    hasRequest: scan.request !== null,
  };
}

/**
 * Score every scan, then judge the set against the bar.
 *
 * `now` is injected so the output is reproducible under test; the CLI passes
 * the real clock.
 */
export function analyse({
  scans = [],
  annotations = [],
  malformedLogLines = [],
  rejectedAnnotations = [],
  duplicateAnnotations = [],
  thresholds = {},
  now = new Date(),
  inputs = {},
} = {}) {
  const bar = { ...DEFAULT_THRESHOLDS, ...thresholds };
  const byId = new Map(annotations.map((a) => [a.scanId, a]));
  const resolved = scans.map((scan) => resolveScan(scan, byId.get(scan.scanId)));

  /** Annotations naming a scanId no log line ever mentioned. A half-join. */
  const seen = new Set(scans.map((s) => s.scanId));
  const orphanAnnotations = annotations.filter((a) => !seen.has(a.scanId)).map((a) => a.scanId);

  const excluded = [];
  const evaluable = [];

  for (const scan of resolved) {
    const reason =
      scan.duplicates.length > 0 ? EXCLUSIONS.DUPLICATE
      : !scan.hasRequest ? EXCLUSIONS.UNJOINED_NO_REQUEST
      : !scan.hasCapture ? EXCLUSIONS.UNJOINED_NO_CAPTURE
      : scan.gateConflict ? EXCLUSIONS.GATE_CONFLICT
      : scan.proposedConflict ? EXCLUSIONS.PROPOSAL_CONFLICT
      : scan.gate === null ? EXCLUSIONS.NO_GATE
      : null;

    if (reason === null) evaluable.push(scan);
    else excluded.push({ scanId: scan.scanId, reason });
  }

  const accepts = evaluable.filter((s) => s.gate.decision === 'accept');
  const rejects = evaluable.filter((s) => s.gate.decision === 'reject');

  // Every reason a rejection carried, kept apart rather than collapsed: which
  // rule is doing the rejecting is the whole question when the coverage number
  // comes back too low. A rejection with no reason at all is named as such so
  // the histogram still sums to something meaningful.
  const rejectionReasons = tally(
    rejects.flatMap((s) => (s.gate.reasons.length > 0 ? s.gate.reasons : ['(unspecified)'])),
  );

  // ---- Accuracy of the would-be accepts -----------------------------------

  const unscorable = [];
  const scored = [];

  for (const scan of accepts) {
    if (scan.truthDate === null) {
      unscorable.push({ scanId: scan.scanId, reason: UNSCORABLE.NO_GROUND_TRUTH });
      continue;
    }
    if (scan.proposedDate === null) {
      unscorable.push({ scanId: scan.scanId, reason: UNSCORABLE.NO_PROPOSED_DATE });
      continue;
    }
    const diffDays = dayDifference(scan.truthDate, scan.proposedDate);
    scored.push({
      ...scan,
      diffDays,
      dateCorrect: diffDays === 0,
      // A would-be accept is false if anything it would have committed without
      // review is wrong — a right date under the wrong name is still a bad row
      // in someone's fridge list.
      correct: diffDays === 0 && scan.nameCorrect !== false,
    });
  }

  const nameMeasured = scored.filter((s) => typeof s.nameCorrect === 'boolean');
  const dateWrong = scored.filter((s) => !s.dateCorrect);
  const later = dateWrong.filter((s) => s.diffDays > 0);
  const earlier = dateWrong.filter((s) => s.diffDays < 0);
  const dangerous = scored.filter((s) => s.diffDays > bar.dangerousLaterDays);
  const falseAccepts = scored.filter((s) => !s.correct);

  const abs = (s) => Math.abs(s.diffDays);
  const errorDistribution = {
    exact: scored.filter((s) => s.diffDays === 0).length,
    within1Day: scored.filter((s) => abs(s) > 0 && abs(s) <= 1).length,
    over1Day: scored.filter((s) => abs(s) > 1).length,
    over7Days: scored.filter((s) => abs(s) > 7).length,
    over30Days: scored.filter((s) => abs(s) > 30).length,
    maxDaysLater: later.length > 0 ? Math.max(...later.map((s) => s.diffDays)) : 0,
    maxDaysEarlier: earlier.length > 0 ? Math.max(...earlier.map((s) => -s.diffDays)) : 0,
  };

  // ---- The bar -------------------------------------------------------------

  const n = scored.length;
  const k = falseAccepts.length;
  const observedRate = rate(k, n);
  const interval = clopperPearsonInterval(k, n, bar.confidence);
  const upperBound = clopperPearsonUpperBound(k, n, bar.confidence);
  const dangerousUpperBound = clopperPearsonUpperBound(dangerous.length, n, bar.confidence);

  const criteria = [
    falseAcceptCriterion({ n, k, observedRate, upperBound, bar }),
    dangerousCriterion({ n, dangerous, upperBound: dangerousUpperBound, bar }),
  ];

  const result = criteria.some((c) => c.result === 'FAIL')
    ? 'FAIL'
    : criteria.some((c) => c.result === 'INSUFFICIENT_EVIDENCE')
      ? 'INSUFFICIENT_EVIDENCE'
      : 'PASS';

  // Only what a person needs to go and look at the scan again. No item names,
  // and no fields beyond the ones that explain why the row is here.
  const failureRecord = (s) => ({
    scanId: s.scanId,
    proposedDate: s.proposedDate,
    truthDate: s.truthDate,
    diffDays: s.diffDays,
    direction: s.diffDays > 0 ? 'later-than-truth' : s.diffDays < 0 ? 'earlier-than-truth' : 'exact',
    nameCorrect: s.nameCorrect ?? null,
    gateDecision: s.gate.decision,
    gateReasons: s.gate.reasons,
    gateOrigin: s.gate.origin,
    read: s.read,
    dateType: s.dateType,
    checks: s.checks,
  });

  return {
    schemaVersion: SCHEMA_VERSION,
    tool: TOOL,
    toolVersion: TOOL_VERSION,
    analysedAt: now.toISOString(),
    inputs,
    thresholds: bar,

    dataset: {
      totalScansDiscovered: scans.length,
      uniqueScanIds: new Set(scans.map((s) => s.scanId)).size,
      duplicateLogLines: resolved.reduce((sum, s) => sum + s.duplicates.length, 0),
      scansWithDuplicateLines: resolved.filter((s) => s.duplicates.length > 0).length,
      incompleteScans: resolved.filter((s) => !s.hasCapture || !s.hasRequest).length,
      malformedLogLines: malformedLogLines.length,
      malformedLogLineReasons: tally(malformedLogLines.map((m) => m.problem)),
      annotationsSupplied: annotations.length,
      annotationsRejected: rejectedAnnotations.length,
      annotationRejectionReasons: tally(rejectedAnnotations.map((r) => r.problem)),
      annotationsDuplicated: duplicateAnnotations.length,
      annotationsWithoutMatchingScan: orphanAnnotations.length,
      scansWithoutGroundTruth: resolved.filter((s) => s.truthDate === null).length,
      excludedScans: excluded.length,
      exclusionReasons: tally(excluded.map((e) => e.reason)),
    },

    coverage: {
      evaluableScans: evaluable.length,
      wouldBeAutoAccepted: accepts.length,
      rejected: rejects.length,
      autoAcceptCoverage: rate(accepts.length, evaluable.length),
      rejectionRate: rate(rejects.length, evaluable.length),
      rejectionReasons,
    },

    accuracy: {
      scoredAccepts: n,
      unscorableAccepts: unscorable.length,
      unscorableReasons: tally(unscorable.map((u) => u.reason)),
      correctAccepts: n - k,
      falseAccepts: k,
      dateCorrect: n - dateWrong.length,
      dateIncorrect: dateWrong.length,
      datesLaterThanTruth: later.length,
      datesEarlierThanTruth: earlier.length,
      nameMeasured: nameMeasured.length,
      nameCorrect: nameMeasured.filter((s) => s.nameCorrect === true).length,
      nameIncorrect: nameMeasured.filter((s) => s.nameCorrect === false).length,
      errorDistribution,
    },

    falseAcceptRate: {
      numerator: k,
      denominator: n,
      observed: observedRate,
      confidence: {
        method: 'Clopper-Pearson exact binomial',
        level: bar.confidence,
        twoSidedInterval: interval,
        oneSidedUpperBound: upperBound,
        note:
          'The verdict uses the one-sided upper bound. Zero observed failures is ' +
          'not evidence of a zero underlying rate.',
      },
    },

    dangerousDateErrors: {
      thresholdDays: bar.dangerousLaterDays,
      count: dangerous.length,
      oneSidedUpperBound: dangerousUpperBound,
      records: dangerous.map(failureRecord),
    },

    incorrectAccepts: falseAccepts.map(failureRecord),

    excluded,
    unscorableAccepts: unscorable,

    safetyBar: { result, criteria },
  };
}

function falseAcceptCriterion({ n, k, observedRate, upperBound, bar }) {
  const id = 'false-auto-accept-rate';
  const pct = (v) => `${(v * 100).toFixed(2)}%`;
  const level = `${(bar.confidence * 100).toFixed(0)}%`;

  if (n === 0) {
    return {
      id,
      description: `False auto-accept rate <= ${pct(bar.maxFalseAcceptRate)}`,
      result: 'INSUFFICIENT_EVIDENCE',
      reason:
        'No would-be auto-accepted scan could be scored, so the rate is undefined. ' +
        `${cleanSampleSizeFor(bar.maxFalseAcceptRate, bar.confidence)} consecutive ` +
        'error-free scored accepts would be needed to establish the bar.',
      observed: null,
      upperBound: null,
    };
  }

  // A point estimate already over the bar is a breach on the evidence in hand;
  // no interval makes that go away.
  if (observedRate > bar.maxFalseAcceptRate) {
    return {
      id,
      description: `False auto-accept rate <= ${pct(bar.maxFalseAcceptRate)}`,
      result: 'FAIL',
      reason:
        `${k} incorrect would-be accept${k === 1 ? '' : 's'} in ${n} scored accepts ` +
        `= ${pct(observedRate)}, above the ${pct(bar.maxFalseAcceptRate)} bar.`,
      observed: observedRate,
      upperBound,
    };
  }

  if (upperBound <= bar.maxFalseAcceptRate) {
    return {
      id,
      description: `False auto-accept rate <= ${pct(bar.maxFalseAcceptRate)}`,
      result: 'PASS',
      reason:
        `${k} incorrect in ${n} scored accepts (${pct(observedRate)}); the ` +
        `${level} one-sided upper bound is ${pct(upperBound)}, within the ` +
        `${pct(bar.maxFalseAcceptRate)} bar.`,
      observed: observedRate,
      upperBound,
    };
  }

  const needed = cleanSampleSizeFor(bar.maxFalseAcceptRate, bar.confidence);
  return {
    id,
    description: `False auto-accept rate <= ${pct(bar.maxFalseAcceptRate)}`,
    result: 'INSUFFICIENT_EVIDENCE',
    reason:
      `${k} error${k === 1 ? '' : 's'} observed in ${n} would-be accepts, but the ` +
      `${level} upper bound remains ${pct(upperBound)}, above ` +
      `${pct(bar.maxFalseAcceptRate)}. ` +
      (k === 0
        ? `${needed} consecutive error-free scored accepts would settle it.`
        : 'A larger sample, or fewer errors in it, is needed.'),
    observed: observedRate,
    upperBound,
    cleanSampleSizeNeeded: k === 0 ? needed : null,
  };
}

function dangerousCriterion({ n, dangerous, upperBound, bar }) {
  const id = 'no-dangerous-late-accepts';
  const description = `Zero accepts more than ${bar.dangerousLaterDays} days later than truth`;
  const pct = (v) => `${(v * 100).toFixed(2)}%`;
  const level = `${(bar.confidence * 100).toFixed(0)}%`;

  if (dangerous.length > 0) {
    return {
      id,
      description,
      result: 'FAIL',
      reason:
        `${dangerous.length} accepted date${dangerous.length === 1 ? ' is' : 's are'} more than ` +
        `${bar.dangerousLaterDays} days later than ground truth: ` +
        dangerous.map((s) => `${s.scanId} (+${s.diffDays}d)`).join(', ') + '.',
      observed: dangerous.length,
      upperBound,
    };
  }

  if (n === 0) {
    return {
      id,
      description,
      result: 'INSUFFICIENT_EVIDENCE',
      reason: 'No scored accepts, so no opportunity for the failure to have shown up.',
      observed: 0,
      upperBound: null,
    };
  }

  if (upperBound <= bar.maxDangerousAcceptRate) {
    return {
      id,
      description,
      result: 'PASS',
      reason:
        `None in ${n} scored accepts, and the ${level} upper bound on the ` +
        `rate is ${pct(upperBound)}, within ${pct(bar.maxDangerousAcceptRate)}.`,
      observed: 0,
      upperBound,
    };
  }

  return {
    id,
    description,
    result: 'INSUFFICIENT_EVIDENCE',
    reason:
      `None observed in ${n} scored accepts, but the ${level} upper bound on the ` +
      `rate is still ${pct(upperBound)}, above ${pct(bar.maxDangerousAcceptRate)}. ` +
      'Observing none in a small sample cannot establish a rule stated as "never".',
    observed: 0,
    upperBound,
    cleanSampleSizeNeeded: cleanSampleSizeFor(bar.maxDangerousAcceptRate, bar.confidence),
  };
}
