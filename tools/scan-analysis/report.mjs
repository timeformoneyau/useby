/**
 * The analysis, written out for someone who was not watching it run.
 *
 * The headline goes first and in one line, because the failure mode of a report
 * like this is that the conclusion is technically present on page three. Every
 * section below the verdict exists to answer "why does it say that", in roughly
 * the order the question gets asked.
 *
 * Rendering only. Everything here is a function of the object `analyse` returns;
 * no number is computed on this side, so the Markdown and the JSON can never
 * disagree about what happened.
 */

const VERDICT = {
  PASS: 'PASS',
  FAIL: 'FAIL',
  INSUFFICIENT_EVIDENCE: 'INSUFFICIENT EVIDENCE',
};

const pct = (v, dp = 2) => (v === null || v === undefined ? '—' : `${(v * 100).toFixed(dp)}%`);
const num = (v) => (v === null || v === undefined ? '—' : String(v));

function table(rows) {
  return ['| | |', '|---|---|', ...rows.map(([k, v]) => `| ${k} | ${v} |`)].join('\n');
}

function histogram(counts, emptyNote) {
  const entries = Object.entries(counts);
  if (entries.length === 0) return `_${emptyNote}_`;
  return [
    '| Reason | Count |',
    '|---|---|',
    ...entries.map(([reason, count]) => `| \`${reason}\` | ${count} |`),
  ].join('\n');
}

export function renderReport(r) {
  const bar = r.thresholds;
  const d = r.dataset;
  const c = r.coverage;
  const a = r.accuracy;
  const e = a.errorDistribution;
  const f = r.falseAcceptRate;
  const out = [];

  out.push('# UseBy scan analysis');
  out.push('');
  out.push(`**Verdict: ${VERDICT[r.safetyBar.result]}**`);
  out.push('');
  for (const criterion of r.safetyBar.criteria) {
    out.push(`- **${VERDICT[criterion.result]}** — ${criterion.description}. ${criterion.reason}`);
  }
  out.push('');
  out.push(
    'This is a measurement of a shadow gate. It does not authorise turning ' +
      'exception-based review on; that remains a separate product decision.',
  );

  out.push('');
  out.push('## Analysis summary');
  out.push('');
  out.push(
    table([
      ['Analysed at', r.analysedAt],
      ['Tool', `${r.tool} ${r.toolVersion} (schema ${r.schemaVersion})`],
      ['Scans discovered', num(d.totalScansDiscovered)],
      ['Evaluable against the gate', num(c.evaluableScans)],
      ['Would-be auto-accepted', num(c.wouldBeAutoAccepted)],
      ['Scored for accuracy', num(a.scoredAccepts)],
      ['Incorrect would-be accepts', num(a.falseAccepts)],
    ]),
  );

  out.push('');
  out.push('## Dataset quality');
  out.push('');
  out.push(
    table([
      ['Total scans discovered', num(d.totalScansDiscovered)],
      ['Unique scan ids', num(d.uniqueScanIds)],
      ['Scans with duplicate log lines', num(d.scansWithDuplicateLines)],
      ['Duplicate log lines', num(d.duplicateLogLines)],
      ['Incomplete scans (a scan stage missing)', num(d.incompleteScans)],
      ['Scans with a gate decision line', num(d.scansWithDecisionLine)],
      ['Scans with an outcome line', num(d.scansWithOutcomeLine)],
      ['Decisions with no outcome (buffer rolled?)', num(d.decisionsWithoutOutcome)],
      ['Malformed log lines', num(d.malformedLogLines)],
      ['Ground-truth records supplied', num(d.annotationsSupplied)],
      ['Ground-truth records rejected', num(d.annotationsRejected)],
      ['Ground-truth records duplicated', num(d.annotationsDuplicated)],
      ['Ground-truth records with no matching scan', num(d.annotationsWithoutMatchingScan)],
      ['Date errors with no truth date supplied', num(d.dateErrorsWithoutSuppliedTruth)],
      ['Scans excluded from evaluation', num(d.excludedScans)],
    ]),
  );

  if (d.malformedLogLines > 0) {
    out.push('');
    out.push('**Malformed log lines**');
    out.push('');
    out.push(histogram(d.malformedLogLineReasons, 'none'));
  }
  if (d.annotationsRejected > 0) {
    out.push('');
    out.push('**Rejected ground-truth records**');
    out.push('');
    out.push(histogram(d.annotationRejectionReasons, 'none'));
  }

  out.push('');
  out.push('**Exclusions**');
  out.push('');
  out.push(histogram(d.exclusionReasons, 'No scan was excluded.'));
  out.push('');
  out.push(
    '_Nothing is discarded silently: every malformed, incomplete or unjoinable ' +
      'record is counted above and every excluded scan is listed with its reason ' +
      'in the JSON output._',
  );

  out.push('');
  out.push('## Gate coverage');
  out.push('');
  out.push(
    table([
      ['Evaluable scans', num(c.evaluableScans)],
      ['Would-be auto-accepted', num(c.wouldBeAutoAccepted)],
      ['Rejected by the gate', num(c.rejected)],
      ['Auto-accept coverage', pct(c.autoAcceptCoverage)],
      ['Rejection rate', pct(c.rejectionRate)],
    ]),
  );

  if (Object.keys(c.advisoryReasons).length > 0) {
    out.push('');
    out.push('**Advisory reasons** (recorded by the gate, never blocking)');
    out.push('');
    out.push(histogram(c.advisoryReasons, 'none'));
  }

  out.push('');
  out.push('## Would-be accept accuracy');
  out.push('');
  out.push(
    table([
      ['Scored accepts', num(a.scoredAccepts)],
      ['Accepts that could not be scored', num(a.unscorableAccepts)],
      ['Correct (date and, where measured, name)', num(a.correctAccepts)],
      ['Incorrect', num(a.falseAccepts)],
      ['Date exactly correct', num(a.dateCorrect)],
      ['Date incorrect', num(a.dateIncorrect)],
      ['— of which the error size is known', num(a.dateErrorsWithKnownMagnitude)],
      ['— of which the error size is unknown', num(a.dateErrorsWithUnknownMagnitude)],
      ['Item name measured', num(a.nameMeasured)],
      ['Item name correct', num(a.nameCorrect)],
      ['Item name incorrect', num(a.nameIncorrect)],
    ]),
  );
  if (a.unscorableAccepts > 0) {
    out.push('');
    out.push(histogram(a.unscorableReasons, 'none'));
  }

  out.push('');
  out.push('**Date error distribution** (across scored accepts)');
  out.push('');
  out.push(
    table([
      ['Exact match', num(e.exact)],
      ['Off by exactly 1 day', num(e.within1Day)],
      ['Off by more than 1 day', num(e.over1Day)],
      ['Off by more than 7 days', num(e.over7Days)],
      ['Off by more than 30 days', num(e.over30Days)],
      ['Later than truth', num(a.datesLaterThanTruth)],
      ['Earlier than truth', num(a.datesEarlierThanTruth)],
      ['Largest overshoot (later than truth)', `${num(e.maxDaysLater)} days`],
      ['Largest undershoot (earlier than truth)', `${num(e.maxDaysEarlier)} days`],
      ['Errors of unknown size', num(e.magnitudeUnknown)],
    ]),
  );
  out.push('');
  out.push(
    '_Later and earlier are reported apart on purpose. A date read earlier than ' +
      'reality wastes food; a date read later than reality is the one that gets ' +
      'someone sick. Averaging them would hide the difference._',
  );

  out.push('');
  out.push('## Dangerous date errors');
  out.push('');
  const dangerous = r.dangerousDateErrors;
  if (dangerous.count === 0) {
    out.push(
      `No would-be accept was measured as proposing a date more than ${dangerous.thresholdDays} ` +
        `days later than ground truth, across ${num(a.scoredAccepts)} scored accepts.`,
    );
    if (dangerous.oneSidedUpperBound !== null) {
      out.push('');
      out.push(
        `The ${pct(bar.confidence, 0)} one-sided upper bound on that rate is still ` +
          `**${pct(dangerous.oneSidedUpperBound)}** — observing none is not the same as ` +
          'establishing none.',
      );
    }
  } else {
    out.push(
      `**${dangerous.count}** would-be accept${dangerous.count === 1 ? '' : 's'} proposed a ` +
        `date more than ${dangerous.thresholdDays} days later than ground truth.`,
    );
    out.push('');
    out.push(failureTable(dangerous.records));
  }

  if (dangerous.unmeasuredDateErrors > 0) {
    out.push('');
    out.push(
      `**${dangerous.unmeasuredDateErrors} date error${dangerous.unmeasuredDateErrors === 1 ? '' : 's'} ` +
        'of unknown size.** The outcome line records *that* the user corrected the date, never ' +
        'what they corrected it to, so the size and direction of these errors cannot be ' +
        'recovered from the logs. Any of them could be an overshoot beyond ' +
        `${dangerous.thresholdDays} days.`,
    );
    out.push('');
    out.push(
      'Supply a `truthDate` for these `scanId`s in the ground-truth file and re-run:',
    );
    out.push('');
    out.push('```json');
    out.push(
      JSON.stringify(
        dangerous.unmeasuredRecords.map((x) => ({
          scanId: x.scanId,
          proposedDate: x.proposedDate,
          truthDate: 'YYYY-MM-DD',
        })),
        null,
        2,
      ),
    );
    out.push('```');
  }

  out.push('');
  out.push('## Rejection reasons');
  out.push('');
  out.push(histogram(c.rejectionReasons, 'No scan was rejected by the gate.'));

  out.push('');
  out.push('## Statistical confidence');
  out.push('');
  out.push(
    table([
      ['Method', f.confidence.method],
      ['Confidence level', pct(f.confidence.level, 0)],
      ['Observed false-accept rate', `${num(f.numerator)} / ${num(f.denominator)} = ${pct(f.observed)}`],
      [
        'Two-sided interval',
        f.confidence.twoSidedInterval
          ? `${pct(f.confidence.twoSidedInterval.lower)} – ${pct(f.confidence.twoSidedInterval.upper)}`
          : '—',
      ],
      ['One-sided upper bound (used for the verdict)', pct(f.confidence.oneSidedUpperBound)],
    ]),
  );
  out.push('');
  out.push(
    'Clopper-Pearson is exact: it inverts the binomial CDF rather than ' +
      'approximating it, so it never claims more precision than the sample size ' +
      'supports. **Zero observed failures does not prove a zero underlying failure ' +
      'probability** — with no errors at all, the upper bound is still ' +
      '`1 − 0.05^(1/n)`, which needs several hundred clean scans before it falls ' +
      'under half a percent.',
  );

  out.push('');
  out.push('## Safety-bar result');
  out.push('');
  out.push(
    table([
      ['Max false auto-accept rate', pct(bar.maxFalseAcceptRate)],
      ['Dangerous overshoot threshold', `${bar.dangerousLaterDays} days later than truth`],
      ['Max dangerous-accept rate', pct(bar.maxDangerousAcceptRate)],
      ['Confidence level', pct(bar.confidence, 0)],
    ]),
  );
  out.push('');
  for (const criterion of r.safetyBar.criteria) {
    out.push(`### ${VERDICT[criterion.result]} — ${criterion.description}`);
    out.push('');
    out.push(criterion.reason);
    out.push('');
  }
  out.push(`**Overall: ${VERDICT[r.safetyBar.result]}**`);

  out.push('');
  out.push('## Notable individual failures');
  out.push('');
  if (r.incorrectAccepts.length === 0) {
    out.push('_No would-be accept was measured as incorrect._');
  } else {
    out.push(failureTable(r.incorrectAccepts));
  }

  out.push('');
  out.push('## Data limitations');
  out.push('');
  for (const line of limitations(r)) out.push(`- ${line}`);

  out.push('');
  return out.join('\n');
}

function failureTable(records) {
  return [
    '| scanId | Proposed | Truth | Δ days | Direction | Name ok | Printed | Format | Advisory |',
    '|---|---|---|---|---|---|---|---|---|',
    ...records.map(
      (x) =>
        `| \`${x.scanId}\` | ${x.proposedDate ?? '—'} | ${x.truthDate ?? '—'} | ` +
        `${x.diffDays === null ? '—' : `${x.diffDays > 0 ? '+' : ''}${x.diffDays}`} | ` +
        `${x.direction} | ${x.nameCorrect === null ? '—' : x.nameCorrect ? 'yes' : 'no'} | ` +
        `${x.sawText === null ? '—' : `\`${x.sawText}\``} | ${x.format ?? '—'} | ` +
        `${x.advisory.length ? x.advisory.map((r) => `\`${r}\``).join(', ') : '—'} |`,
    ),
  ].join('\n');
}

/**
 * The caveats, derived rather than boilerplate — a limitation is only listed
 * when this dataset actually has it.
 */
function limitations(r) {
  const notes = [];
  const d = r.dataset;
  const a = r.accuracy;

  if (d.totalScansDiscovered === 0) {
    notes.push('**No scans were found in the supplied logs.** Nothing below is measured.');
  }
  if (a.dateErrorsWithUnknownMagnitude > 0) {
    notes.push(
      `**${a.dateErrorsWithUnknownMagnitude} date error(s) of unknown size.** The outcome line ` +
        'records that the date was corrected, not what it became, so the dangerous-overshoot ' +
        'criterion cannot be settled without a `truthDate` supplied for each.',
    );
  }
  if (d.decisionsWithoutOutcome > 0) {
    notes.push(
      `${d.decisionsWithoutOutcome} scan(s) reached a gate decision but no outcome line. These ` +
        'lines live only in the Android log buffer, so a long or noisy session can roll them ' +
        'away — dump promptly after each run.',
    );
  }
  if (d.exclusionReasons['recognition-failed'] > 0) {
    notes.push(
      `${d.exclusionReasons['recognition-failed']} scan(s) were excluded because recognition ` +
        'produced nothing usable. That is deliberate: a photograph of a bag of onions is not a ' +
        'gate failure, and counting it would understate coverage for reasons unrelated to the gate.',
    );
  }
  if (d.exclusionReasons['not-saved'] > 0) {
    notes.push(
      `${d.exclusionReasons['not-saved']} scan(s) were discarded or retaken rather than saved, ` +
        'so the user never settled on a value and there is no ground truth for them.',
    );
  }
  if (a.appFlagDisagreements > 0) {
    notes.push(
      `**${a.appFlagDisagreements} scan(s) where the app's own \`falseAccept\` flag disagrees ` +
        "with this analysis.** That should not happen; investigate before trusting either number.",
    );
  }
  if (d.annotationsWithoutMatchingScan > 0) {
    notes.push(
      `${d.annotationsWithoutMatchingScan} ground-truth record(s) name a scanId that appears ` +
        'in no log line. Either the log export is incomplete or the id was mistyped.',
    );
  }
  if (d.malformedLogLines > 0) {
    notes.push(
      `${d.malformedLogLines} log line(s) were malformed and could not be read. ` +
        'A truncated logcat buffer is the usual cause.',
    );
  }
  if (a.nameMeasured < a.scoredAccepts) {
    notes.push(
      `Item-name correctness was measurable for ${a.nameMeasured} of ${a.scoredAccepts} scored ` +
        'accepts; the rest are scored on the date alone.',
    );
  }
  notes.push(
    'A scan waved through without correction is recorded as correct. The measurement rests on ' +
      'the collector actually correcting everything that was wrong.',
  );
  notes.push(
    'The gate is measured as it behaved during collection. This report says nothing about how ' +
      'it would behave after any change to it, and re-running it after tuning the gate on this ' +
      'same dataset measures the tuning, not the gate.',
  );
  notes.push(
    'A pass here is evidence about a dataset, not authorisation to change product behaviour. ' +
      'Mandatory Review & Save remains in force.',
  );
  return notes;
}
