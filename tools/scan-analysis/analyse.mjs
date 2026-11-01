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
import { dayDifference, readDecision, readOutcome } from './parse.mjs';

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
  NO_DECISION: 'no-decision-line',
  NO_OUTCOME: 'no-outcome-line',
  /**
   * The gate reached no decision because recognition produced nothing usable.
   * Kept out of the coverage denominator on purpose: a photograph of a bag of
   * onions is not a gate failure, and counting it as one would understate
   * coverage for reasons that have nothing to do with the gate.
   */
  RECOGNITION_FAILED: 'recognition-failed',
  /** Discarded or retaken. The user never settled on a value, so there is no truth. */
  NOT_SAVED: 'not-saved',
  VERDICT_CONFLICT: 'verdict-conflict',
  PROPOSAL_CONFLICT: 'proposed-date-conflict',
};

/** Why a would-be accept could not be scored for accuracy. */
export const UNSCORABLE = {
  /** The save carried no correction flags at all — a truncated outcome line. */
  NO_CORRECTION_FLAGS: 'no-correction-flags',
  /** Recognition returned no date and the user typed one. Not a wrong date. */
  DATE_SUPPLIED_NOT_CORRECTED: 'date-supplied-not-corrected',
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
 * Decide what one scan contributes, given its log lines and any annotation.
 *
 * Where both a log line and a hand-written note carry the same field the log
 * wins and the disagreement is recorded — never quietly reconciled. The two
 * disagreeing means one of them is wrong about the run, and averaging over that
 * would launder a bookkeeping error into a measurement.
 */
export function resolveScan(scan, annotation) {
  const decision = scan.decision ? readDecision(scan.decision.entry) : null;
  const outcome = scan.outcome ? readOutcome(scan.outcome.entry) : null;

  const noteVerdict = annotation?.verdict ?? null;
  const verdictConflict =
    decision !== null && noteVerdict !== null && decision.verdict !== noteVerdict;
  const verdict = decision?.verdict ?? noteVerdict;

  // What the editor was actually prefilled with, which is what the gate would
  // have committed. `derivedIso` is the rules' own reading and is only a
  // fallback: on an auto_accept the two agree by construction, because a
  // disagreement is itself a blocking reason.
  const logProposed = decision?.modelIso ?? decision?.derivedIso ?? null;
  const noteProposed = annotation?.proposedDate ?? null;
  const proposedConflict =
    logProposed !== null && noteProposed !== null && logProposed !== noteProposed;

  return {
    scanId: scan.scanId,
    decision,
    outcome,
    verdict,
    verdictConflict,
    proposedDate: logProposed ?? noteProposed,
    proposedConflict,
    truthDate: annotation?.truthDate ?? null,
    // The logs answer this themselves; an annotation only overrides.
    nameCorrect:
      annotation?.nameCorrect ??
      (outcome?.nameChanged === undefined ? undefined : !outcome.nameChanged),
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
      : scan.verdictConflict ? EXCLUSIONS.VERDICT_CONFLICT
      : scan.proposedConflict ? EXCLUSIONS.PROPOSAL_CONFLICT
      : scan.verdict === null ? EXCLUSIONS.NO_DECISION
      : scan.verdict === 'failed' ? EXCLUSIONS.RECOGNITION_FAILED
      : scan.outcome === null ? EXCLUSIONS.NO_OUTCOME
      : scan.outcome.action !== 'saved' ? EXCLUSIONS.NOT_SAVED
      : null;

    if (reason === null) evaluable.push(scan);
    else excluded.push({ scanId: scan.scanId, reason });
  }

  const accepts = evaluable.filter((s) => s.verdict === 'auto_accept');
  const rejects = evaluable.filter((s) => s.verdict === 'review');

  // Every reason a rejection carried, kept apart rather than collapsed: which
  // rule is doing the rejecting is the whole question when coverage comes back
  // too low, and a run that is 40% AMBIGUOUS_DATE calls for completely
  // different work from one that is 40% NO_DATE_TEXT.
  const rejectionReasons = tally(
    rejects.flatMap((s) =>
      s.decision !== null && s.decision.blocking.length > 0
        ? s.decision.blocking
        : ['(unspecified)'],
    ),
  );
  // Advisory reasons never blocked anything, so they are reported apart. Folding
  // them in would put conditions that cost no coverage into the histogram that
  // decides where coverage is being lost.
  const advisoryReasons = tally(
    evaluable.flatMap((s) => s.decision?.advisory ?? []),
  );

  // ---- Accuracy of the would-be accepts -----------------------------------
  //
  // This comes off the logs alone. The outcome line records whether the user
  // corrected the date; a would-be accept they corrected is one the gate would
  // have committed wrongly. The magnitude of that error is a separate question
  // and needs the annotations file — see below.

  const unscorable = [];
  const scored = [];

  for (const scan of accepts) {
    const { outcome } = scan;

    if (outcome.dateChanged === undefined) {
      unscorable.push({ scanId: scan.scanId, reason: UNSCORABLE.NO_CORRECTION_FLAGS });
      continue;
    }
    // Recognition returned no date and the user typed one in. That is not a
    // corrected wrong date, and folding the two together would inflate the
    // error rate with cases the gate had already rejected. An auto_accept
    // cannot reach this state (NO_DATE_READ blocks), so it means a malformed
    // pairing rather than a real outcome.
    if (outcome.dateSupplied === true) {
      unscorable.push({ scanId: scan.scanId, reason: UNSCORABLE.DATE_SUPPLIED_NOT_CORRECTED });
      continue;
    }

    const dateCorrect = outcome.dateChanged === false;
    const nameCorrect = scan.nameCorrect;

    // Only measurable where the user's corrected value was supplied by hand:
    // the outcome line records that the date changed, never what it changed to.
    const diffDays =
      !dateCorrect && scan.truthDate !== null && scan.proposedDate !== null
        ? dayDifference(scan.truthDate, scan.proposedDate)
        : null;

    scored.push({
      ...scan,
      dateCorrect,
      diffDays,
      magnitudeKnown: dateCorrect || diffDays !== null,
      // A would-be accept is false if anything it would have committed without
      // review is wrong — a right date under the wrong name is still a bad row
      // in someone's fridge list. The app's own `falseAccept` flag counts the
      // date only; both are reported.
      correct: dateCorrect && nameCorrect !== false,
    });
  }

  const nameMeasured = scored.filter((s) => typeof s.nameCorrect === 'boolean');
  const dateWrong = scored.filter((s) => !s.dateCorrect);
  const measured = dateWrong.filter((s) => s.diffDays !== null);
  const unmeasured = dateWrong.filter((s) => s.diffDays === null);
  const later = measured.filter((s) => s.diffDays > 0);
  const earlier = measured.filter((s) => s.diffDays < 0);
  const dangerous = measured.filter((s) => s.diffDays > bar.dangerousLaterDays);
  const falseAccepts = scored.filter((s) => !s.correct);

  // Where the app computed its own verdict on the same scan, it must agree.
  // A mismatch means the harness and the app disagree about what happened, and
  // that is worth surfacing rather than quietly preferring one of them.
  const flagDisagreements = scored.filter(
    (s) => s.outcome.falseAccept !== undefined && s.outcome.falseAccept !== !s.dateCorrect,
  ).length;

  const abs = (s) => Math.abs(s.diffDays);
  const errorDistribution = {
    exact: scored.filter((s) => s.dateCorrect).length,
    within1Day: measured.filter((s) => abs(s) > 0 && abs(s) <= 1).length,
    over1Day: measured.filter((s) => abs(s) > 1).length,
    over7Days: measured.filter((s) => abs(s) > 7).length,
    over30Days: measured.filter((s) => abs(s) > 30).length,
    maxDaysLater: later.length > 0 ? Math.max(...later.map((s) => s.diffDays)) : 0,
    maxDaysEarlier: earlier.length > 0 ? Math.max(...earlier.map((s) => -s.diffDays)) : 0,
    magnitudeUnknown: unmeasured.length,
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
    dangerousCriterion({
      n,
      dangerous,
      unmeasured: unmeasured.length,
      upperBound: dangerousUpperBound,
      bar,
    }),
  ];

  // Any breach fails the set; otherwise a criterion that could not be
  // established holds the whole result back. A PASS means every criterion was
  // positively demonstrated, not merely left unbreached.
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
    direction:
      s.diffDays === null
        ? 'unmeasured'
        : s.diffDays > 0
          ? 'later-than-truth'
          : s.diffDays < 0
            ? 'earlier-than-truth'
            : 'exact',
    dateCorrect: s.dateCorrect,
    nameCorrect: s.nameCorrect ?? null,
    verdict: s.verdict,
    blocking: s.decision?.blocking ?? [],
    advisory: s.decision?.advisory ?? [],
    // The printed characters and both routes' reading of them. This is what
    // makes a row in the failure table into something someone can diagnose:
    // a date the model normalised differently from the rules, or a format the
    // parser handled badly, shows up here and nowhere else.
    sawText: s.decision?.sawText ?? null,
    sawLabel: s.decision?.sawLabel ?? null,
    otherDatesVisible: s.decision?.others ?? null,
    derivedIso: s.decision?.derivedIso ?? null,
    modelIso: s.decision?.modelIso ?? null,
    format: s.decision?.format ?? null,
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
      scansWithDecisionLine: resolved.filter((s) => s.decision !== null).length,
      scansWithOutcomeLine: resolved.filter((s) => s.outcome !== null).length,
      // A decision with no outcome is the signature of a rolled log buffer or
      // an app killed mid-session, and it is the most likely way a real run
      // loses data.
      decisionsWithoutOutcome: resolved.filter((s) => s.decision !== null && s.outcome === null).length,
      malformedLogLines: malformedLogLines.length,
      malformedLogLineReasons: tally(malformedLogLines.map((m) => m.problem)),
      annotationsSupplied: annotations.length,
      annotationsRejected: rejectedAnnotations.length,
      annotationRejectionReasons: tally(rejectedAnnotations.map((r) => r.problem)),
      annotationsDuplicated: duplicateAnnotations.length,
      annotationsWithoutMatchingScan: orphanAnnotations.length,
      dateErrorsWithoutSuppliedTruth: unmeasured.length,
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
      advisoryReasons,
    },

    accuracy: {
      scoredAccepts: n,
      unscorableAccepts: unscorable.length,
      unscorableReasons: tally(unscorable.map((u) => u.reason)),
      correctAccepts: n - k,
      falseAccepts: k,
      dateCorrect: n - dateWrong.length,
      dateIncorrect: dateWrong.length,
      dateErrorsWithKnownMagnitude: measured.length,
      dateErrorsWithUnknownMagnitude: unmeasured.length,
      datesLaterThanTruth: later.length,
      datesEarlierThanTruth: earlier.length,
      nameMeasured: nameMeasured.length,
      nameCorrect: nameMeasured.filter((s) => s.nameCorrect === true).length,
      nameIncorrect: nameMeasured.filter((s) => s.nameCorrect === false).length,
      appFlagDisagreements: flagDisagreements,
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
      // Date errors whose size is not recoverable from the logs, because the
      // corrected value was never written to one. Any of these could be a
      // dangerous overshoot, so the criterion cannot pass while they exist.
      unmeasuredDateErrors: unmeasured.length,
      oneSidedUpperBound: dangerousUpperBound,
      records: dangerous.map(failureRecord),
      unmeasuredRecords: unmeasured.map(failureRecord),
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

function dangerousCriterion({ n, dangerous, unmeasured, upperBound, bar }) {
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

  // The logs record that a date was corrected, never what it was corrected to.
  // An error of unknown size could be a dangerous overshoot, so the criterion
  // cannot be evaluated until those scans have a truth date supplied.
  if (unmeasured > 0) {
    return {
      id,
      description,
      result: 'INSUFFICIENT_EVIDENCE',
      reason:
        `${unmeasured} would-be accept${unmeasured === 1 ? ' had its' : 's had their'} date ` +
        'corrected, but the corrected value is not in the logs, so the size of the error ' +
        'cannot be measured. Any of them could be an overshoot beyond ' +
        `${bar.dangerousLaterDays} days. Supply a truthDate for ${unmeasured === 1 ? 'it' : 'them'} ` +
        'in the ground-truth file to settle this.',
      observed: 0,
      upperBound,
      unmeasuredDateErrors: unmeasured,
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
