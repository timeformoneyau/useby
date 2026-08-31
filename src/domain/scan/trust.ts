/**
 * The shadow trust gate: would this scan have been safe to accept without
 * asking anyone?
 *
 * **It decides nothing.** Nothing in the app reads the verdict to change what
 * happens: every scan still goes to Review & Save, every item is still saved by
 * a person pressing Save. This exists to be written to a log line and compared,
 * later, against what the user actually did — so the question "could review
 * become exception-based?" gets an answer from evidence instead of from
 * optimism. Wiring it to behaviour is a separate decision that needs the data
 * this produces.
 *
 * Two design commitments, both from the 30 August spike and both re-checked
 * against the code here.
 *
 * **A conjunction, not a score.** Every safety-critical condition must hold. A
 * weighted score would let a strong signal compensate for a fatal one — the
 * model's own `high` confidence outvoting a genuinely ambiguous `04/09/26` —
 * and that is precisely the failure the gate exists to prevent. It also implies
 * a calibration we do not have.
 *
 * **The model's self-reported confidence is a veto and never a reason.** The
 * Anthropic API exposes no logprobs and no calibrated probability of any kind;
 * the `high | medium | low` field is a token the model writes in the same
 * forward pass that produced the answer it is grading. Anything short of `high`
 * blocks, but `high` on its own earns nothing.
 *
 * One deliberate refinement to the spike: it listed date semantics among the
 * conditions, and this treats an unknown date *type* as advisory rather than
 * blocking. Not knowing whether a pack said "use by" or "best before" does not
 * make the date wrong, and the app already presents an unclassified date
 * honestly. Wrong dates are the serious failure; an unlabelled one is not a
 * wrong one. Rejecting every bare printed date would cost a large share of
 * coverage to buy no date safety at all.
 *
 * Exercised offline in full — see the note on the import below for the one
 * wrinkle that makes that possible.
 */
import type { Confidence, DateType } from '../../types';
// Imported with its extension, which is not the usual style here and is
// deliberate. This module is loaded by the offline suite under Node's type
// stripping, which does not resolve extensionless paths — the same constraint
// that forced `mapping.ts` and `pending.ts` to be `import type` only. Those
// could avoid a runtime import entirely; the gate genuinely needs the parser,
// so the path is spelled out instead of the two being merged into one file to
// work around a test runner. Metro resolves explicit extensions, and the
// Android bundle export is what proves it.
import { classifyDateLabel, parseDateText, type ParsedDateText } from './dateText.ts';

/**
 * Why a scan would not have been auto-accepted.
 *
 * Machine-readable and stable, because their distribution across a real run is
 * the output that says where effort would actually pay: a run that is 40%
 * `AMBIGUOUS_DATE` and a run that is 40% `NO_DATE_TEXT` call for completely
 * different work.
 */
export type TrustReason =
  /** The model returned no usable date at all. */
  | 'NO_DATE_READ'
  /** No verbatim printed characters, so nothing could be checked independently. */
  | 'NO_DATE_TEXT'
  /** Characters were returned but do not resolve to a date. */
  | 'DATE_TEXT_UNPARSEABLE'
  /** The printed string admits more than one valid reading. */
  | 'AMBIGUOUS_DATE'
  /** No year was printed, so the year had to be guessed. */
  | 'YEAR_NOT_PRINTED'
  /** A month-and-year date with no day printed. */
  | 'DAY_NOT_PRINTED'
  /** Our reading of the characters disagrees with the model's normalised date. */
  | 'PARSE_MISMATCH'
  /** Other dates are visible and no wording says which one was chosen. */
  | 'MULTIPLE_CANDIDATES'
  /** Outside the window any grocery date could plausibly fall in. */
  | 'IMPLAUSIBLE_DATE'
  /** The model was not confident about the date. Veto only. */
  | 'LOW_DATE_CONFIDENCE'
  /** Nothing to call the item — it could not be saved as it stands. */
  | 'NO_ITEM_NAME'
  /* --- advisory below: recorded, never blocking --- */
  /** No wording, or wording that does not say what kind of date this is. */
  | 'DATE_TYPE_UNKNOWN'
  /** The wording and the model's classification disagree. */
  | 'DATE_TYPE_MISMATCH'
  /** The model was not confident about the name. */
  | 'LOW_NAME_CONFIDENCE'
  /** A name so generic it will not identify the item later. */
  | 'GENERIC_ITEM_NAME';

export type TrustVerdict =
  /** Would have been saved without asking. */
  | 'auto_accept'
  /** A real result, but something blocked it. */
  | 'review'
  /** Nothing usable came back; there was no decision to make. */
  | 'failed';

export interface TrustDecision {
  verdict: TrustVerdict;
  /** Every condition that failed. All of them, not the first — the histogram wants the lot. */
  blocking: TrustReason[];
  advisory: TrustReason[];
  /** What the rules derived from the printed characters, for the log line. */
  derived: {
    iso: string | null;
    format: string;
    dateType: DateType | null;
  };
}

/**
 * What the model observed, as distinct from what it concluded.
 *
 * `dateText`, `dateLabelText` and `otherDateTexts` are observations — printed
 * characters, reported without interpretation. `expiryDate` and `dateType` are
 * the model's own conclusions, kept precisely so the two can be compared.
 *
 * Every field is optional because a proxy that has not shipped the evidence
 * block yet simply will not send them. That case is not an error: it produces
 * `NO_DATE_TEXT` and a `review` verdict, which is the correct and safe answer
 * to "could this have been accepted on the evidence available".
 */
export interface RecognitionEvidence {
  itemName: string | null;
  nameConfidence: Confidence;
  /** The model's normalised date. */
  expiryDate: string | null;
  dateConfidence: Confidence;
  /** The model's classification. */
  dateType: DateType;
  /** Verbatim characters as printed. */
  dateText?: string | null;
  /** Verbatim wording printed with the date. */
  dateLabelText?: string | null;
  /** Every other date-like string visible on the pack. */
  otherDateTexts?: string[];
}

/**
 * How far out a grocery date can plausibly be.
 *
 * Two days back because a use-by that passed yesterday is a real thing to be
 * holding; three years forward because tinned goods exist. Wide on purpose:
 * this catches a year read as 2062, and it is honest about what it cannot
 * catch — a day-month transposition lands well inside the window, which is why
 * `AMBIGUOUS_DATE` and not this is the condition doing the real work.
 */
const PAST_TOLERANCE_DAYS = 2;
const FUTURE_TOLERANCE_DAYS = 1095;

/** Names that pass validation but will not tell three similar packs apart. */
const GENERIC_NAMES = new Set([
  'food', 'item', 'product', 'grocery', 'groceries',
  'package', 'packet', 'pack', 'container', 'unknown',
]);

function daysBetween(from: Date, isoDate: string): number {
  const [y, m, d] = isoDate.split('-').map(Number);
  return Math.round((Date.UTC(y, m - 1, d) - from.getTime()) / 86_400_000);
}

/**
 * Run the gate.
 *
 * `today` is a parameter so the plausibility window and the year-inference rule
 * are testable, and so one evaluation cannot straddle midnight.
 */
export function evaluateRecognitionTrust(
  evidence: RecognitionEvidence,
  today: Date,
): TrustDecision {
  const blocking: TrustReason[] = [];
  const advisory: TrustReason[] = [];

  const hasName = evidence.itemName !== null && evidence.itemName.trim().length > 0;
  const hasDate = evidence.expiryDate !== null;

  // Nothing came back worth judging. Distinguished from a rejection so the
  // coverage figures are not polluted by scans that never had a result: a
  // photo of a bag of onions is not a gate failure.
  if (!hasName && !hasDate) {
    return {
      verdict: 'failed',
      blocking: ['NO_DATE_READ', 'NO_ITEM_NAME'],
      advisory: [],
      derived: { iso: null, format: 'none', dateType: null },
    };
  }

  let parsed: ParsedDateText | null = null;
  const dateText = evidence.dateText ?? null;

  if (dateText === null || dateText.trim().length === 0) {
    blocking.push('NO_DATE_TEXT');
  } else {
    parsed = parseDateText(dateText, today);

    if (parsed.dayMissing) blocking.push('DAY_NOT_PRINTED');
    if (parsed.ambiguous) blocking.push('AMBIGUOUS_DATE');
    if (parsed.yearInferred) blocking.push('YEAR_NOT_PRINTED');
    if (parsed.iso === null && !parsed.dayMissing && !parsed.ambiguous) {
      blocking.push('DATE_TEXT_UNPARSEABLE');
    }
  }

  if (!hasDate) blocking.push('NO_DATE_READ');

  // The cross-check, and the reason the model's own normalised date is still
  // worth having. Two independent routes to the same date agreeing is real
  // evidence; disagreeing means one of them applied a convention the other did
  // not, and there is no way to tell which from here.
  if (parsed?.iso && evidence.expiryDate && parsed.iso !== evidence.expiryDate) {
    blocking.push('PARSE_MISMATCH');
  }

  if (evidence.expiryDate) {
    const offset = daysBetween(today, evidence.expiryDate);
    if (offset < -PAST_TOLERANCE_DAYS || offset > FUTURE_TOLERANCE_DAYS) {
      blocking.push('IMPLAUSIBLE_DATE');
    }
  }

  // Other dates on the pack, and no wording to say which one was picked. With
  // a label — "USE BY 04/09/26" beside a packed-on date — the choice is
  // evidenced rather than assumed.
  const others = evidence.otherDateTexts ?? [];
  const labelText = evidence.dateLabelText ?? null;
  if (others.length > 0 && labelText === null) blocking.push('MULTIPLE_CANDIDATES');

  // Veto only. `high` is not a reason to accept anything; anything less is a
  // reason to stop. See the note at the top of this file.
  if (evidence.dateConfidence !== 'high') blocking.push('LOW_DATE_CONFIDENCE');

  // An item with no name cannot be saved as it stands — the editor's Save is
  // disabled without one — so this is a genuine blocker rather than a quality
  // concern.
  if (!hasName) blocking.push('NO_ITEM_NAME');

  const labelType = classifyDateLabel(labelText);
  if (labelType === null || labelType === 'unknown') advisory.push('DATE_TYPE_UNKNOWN');
  else if (labelType !== evidence.dateType) advisory.push('DATE_TYPE_MISMATCH');

  if (evidence.nameConfidence !== 'high') advisory.push('LOW_NAME_CONFIDENCE');
  if (hasName && GENERIC_NAMES.has(evidence.itemName!.trim().toLowerCase())) {
    advisory.push('GENERIC_ITEM_NAME');
  }

  return {
    verdict: blocking.length === 0 ? 'auto_accept' : 'review',
    blocking,
    advisory,
    derived: {
      iso: parsed?.iso ?? null,
      format: parsed?.format ?? 'none',
      dateType: labelType,
    },
  };
}

/**
 * What the user did with the scan, which is the other half of the measurement.
 *
 * A shadow verdict on its own says nothing. Paired with whether the person then
 * corrected the date, it becomes the only number that matters:
 * `falseAccept` — the gate would have saved this silently, and the date was
 * wrong.
 *
 * `dateChanged` and `dateSupplied` are deliberately separate. A scan that
 * returned no date at all and had one typed in is not a correction of a wrong
 * date; folding the two together would inflate the error rate with cases the
 * gate already rejected.
 */
export interface ShadowOutcome {
  /** The recognised date was replaced with a different one. */
  dateChanged: boolean;
  /** No date was recognised and the user provided one. */
  dateSupplied: boolean;
  nameChanged: boolean;
  dateTypeChanged: boolean;
  /** The metric. Auto-accepted in shadow, and the date turned out to be wrong. */
  falseAccept: boolean;
}

export interface ReviewedValues {
  name: string;
  expiryDate: string | null;
  dateType: DateType;
}

export function shadowOutcome(
  verdict: TrustVerdict,
  recognised: ReviewedValues,
  saved: ReviewedValues,
): ShadowOutcome {
  const dateSupplied = recognised.expiryDate === null && saved.expiryDate !== null;
  const dateChanged =
    recognised.expiryDate !== null &&
    saved.expiryDate !== null &&
    recognised.expiryDate !== saved.expiryDate;

  return {
    dateChanged,
    dateSupplied,
    nameChanged: recognised.name.trim() !== saved.name.trim(),
    dateTypeChanged: recognised.dateType !== saved.dateType,
    falseAccept: verdict === 'auto_accept' && dateChanged,
  };
}
