/**
 * Pure translation between the proxy's wire contract and the Review & Save
 * editor's prefill.
 *
 * Deliberately free of React Native, `fetch` and the config module so the
 * offline test suite can import it directly under Node's type stripping. Every
 * import here is `import type`, which type stripping erases outright — a value
 * import would need to resolve at runtime and extensionless paths do not.
 * (The proxy repo hit exactly this and solved it the same way.)
 */
import type {
  AddScreenPrefill,
  Confidence,
  DateType,
  ExtractedFields,
  ItemSource,
  ObservedText,
} from '../../types';
import type { RecognitionEvidence, TrustDecision } from './trust';

export const DATE_TYPES: readonly DateType[] = ['use_by', 'best_before', 'unknown'];

/** Why a scan did not produce a prefill. Every one of these still ends in manual entry. */
export type ScanFailureReason =
  | 'not-configured'
  | 'timeout'
  | 'network'
  | 'unauthorized'
  | 'rejected'
  | 'too-large'
  | 'server'
  | 'unreadable'
  | 'malformed';

export type ScanResult =
  | {
      ok: true;
      prefill: AddScreenPrefill;
      /**
       * What the shadow gate would have decided. Carried, logged and compared —
       * never consulted. Nothing downstream branches on it.
       */
      trust: TrustDecision;
    }
  | { ok: false; reason: ScanFailureReason; message: string };

/**
 * User-facing copy for each failure.
 *
 * Written here rather than passed through from the server's `error` string.
 * The proxy's messages are human-readable, but rendering arbitrary server text
 * in the UI couples our copy to a separately deployed service and would let a
 * future proxy change alter what the app says. Every message ends in the same
 * place — type it in yourself — because manual entry is always available and a
 * wrong date is worse than no date.
 */
const FAILURE_MESSAGES: Record<ScanFailureReason, string> = {
  'not-configured': "Scanning isn't set up in this build — add the item manually.",
  timeout: 'Reading the label took too long. Type it in, or try another photo.',
  network: "Couldn't reach UseBy just now. Check your connection, or type it in.",
  unauthorized: "This build can't sign in to the scanner — add the item manually.",
  rejected: "That photo couldn't be sent. Try another one, or type it in.",
  'too-large': 'That photo is too large — try a closer shot, or type it in.',
  server: 'The scanner is unavailable right now. Type it in for the moment.',
  unreadable: "Couldn't read that one. Try a clearer photo, or type it in.",
  malformed: "Couldn't read that one. Try a clearer photo, or type it in.",
};

export function failureMessage(reason: ScanFailureReason): string {
  return FAILURE_MESSAGES[reason];
}

export function scanFailure(reason: ScanFailureReason): ScanResult {
  return { ok: false, reason, message: failureMessage(reason) };
}

/** Map an HTTP status from the proxy onto a failure reason. */
export function reasonForStatus(status: number): ScanFailureReason {
  if (status === 401) return 'unauthorized';
  if (status === 413) return 'too-large';
  if (status === 400 || status === 405) return 'rejected';
  if (status === 502) return 'unreadable';
  return 'server';
}

function isDateType(value: unknown): value is DateType {
  return DATE_TYPES.includes(value as DateType);
}

/**
 * Anything the proxy did not classify becomes `unknown`.
 *
 * The proxy already guarantees this, but the app should not fall over if a
 * future deployment returns a value this build has never heard of. Defaulting
 * to `unknown` fails in the D1 direction — an unrecognised label never becomes
 * a claim the packaging did not make.
 */
export function normaliseDateType(value: unknown): DateType {
  return isDateType(value) ? value : 'unknown';
}

function isConfidence(value: unknown): value is Confidence {
  return value === 'high' || value === 'medium' || value === 'low';
}

/** Treat an unreadable confidence as the least certain one. */
function confidenceOf(value: unknown): Confidence {
  return isConfidence(value) ? value : 'low';
}

function textValue(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** True only for a well-formed YYYY-MM-DD that is also a real calendar date. */
export function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  if (month < 1 || month > 12 || day < 1) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

/** Longest verbatim string we will carry, and the most alternative dates. */
const MAX_OBSERVED_CHARS = 40;
const MAX_OTHER_DATES = 6;

function observedText(value: unknown): string | null {
  const text = textValue(value);
  return text === null ? null : text.slice(0, MAX_OBSERVED_CHARS);
}

/**
 * Read the verbatim observations, if this proxy sends any.
 *
 * Returns `undefined` rather than an empty shape when the block is absent, so
 * "this deployment does not report observations" stays distinguishable from
 * "it looked and saw nothing printed". The trust gate treats those differently
 * and conflating them would quietly turn a deployment gap into a finding about
 * packaging.
 *
 * Bounded on the way in. These strings reach a log line, and they arrive from a
 * separately deployed service, so a rogue or mis-deployed proxy must not be
 * able to put something enormous into one.
 */
export function readObserved(fields: Record<string, unknown>): ObservedText | undefined {
  const raw = fields.observed;
  if (typeof raw !== 'object' || raw === null) return undefined;

  const block = raw as { dateText?: unknown; dateLabelText?: unknown; otherDateTexts?: unknown };

  const others = Array.isArray(block.otherDateTexts)
    ? block.otherDateTexts
        .map(observedText)
        .filter((t): t is string => t !== null)
        .slice(0, MAX_OTHER_DATES)
    : [];

  return {
    dateText: observedText(block.dateText),
    dateLabelText: observedText(block.dateLabelText),
    otherDateTexts: others,
  };
}

/**
 * Everything the shadow trust gate needs, in one flat shape.
 *
 * Lives here because the split between what the model *observed* and what it
 * *concluded* is a property of the wire contract, and this is where the wire
 * contract is read.
 */
export function toEvidence(fields: ExtractedFields): RecognitionEvidence {
  return {
    itemName: fields.itemName.value,
    nameConfidence: fields.itemName.confidence,
    expiryDate: fields.expiryDate.value,
    dateConfidence: fields.expiryDate.confidence,
    dateType: fields.dateType.value,
    dateText: fields.observed?.dateText ?? null,
    dateLabelText: fields.observed?.dateLabelText ?? null,
    otherDateTexts: fields.observed?.otherDateTexts ?? [],
  };
}

/**
 * Validate a `200` body against the response contract.
 *
 * The proxy normalises before responding, so this is a second line rather than
 * the first. It exists because the app and the proxy deploy independently: a
 * mismatched deployment should land the user in manual entry, not crash the
 * capture screen or write a hallucinated date into storage.
 */
export function readFields(body: unknown): ExtractedFields | null {
  if (typeof body !== 'object' || body === null) return null;
  const envelope = body as { ok?: unknown; fields?: unknown };
  if (envelope.ok !== true) return null;
  if (typeof envelope.fields !== 'object' || envelope.fields === null) return null;

  const fields = envelope.fields as Record<string, { value?: unknown; confidence?: unknown }>;
  const { itemName, expiryDate, dateType } = fields;
  if (!itemName || !expiryDate || !dateType) return null;

  const date = textValue(expiryDate.value);
  const observed = readObserved(fields as Record<string, unknown>);

  return {
    ...(observed ? { observed } : {}),
    itemName: {
      value: textValue(itemName.value),
      confidence: confidenceOf(itemName.confidence),
    },
    expiryDate: {
      // A date that is not a real calendar date is dropped rather than shown.
      value: date && isIsoDate(date) ? date : null,
      confidence: confidenceOf(expiryDate.confidence),
    },
    dateType: {
      value: normaliseDateType(dateType.value),
      confidence: confidenceOf(dateType.confidence),
    },
  };
}

/**
 * Turn an extraction into the editor's starting state.
 *
 * A field earns an attention flag when it is missing, or when the model was
 * anything short of confident. That is the whole of the uncertainty model the
 * UI gets: a boolean per field, which the editor renders as actionable wording.
 * The high/medium/low grades stop here — the accepted design forbids showing
 * numeric or graded confidence, and "worth checking" is what the user can act
 * on anyway.
 */
export function toPrefill(
  fields: ExtractedFields,
  source: ItemSource = 'photo',
): AddScreenPrefill {
  return {
    name: fields.itemName.value ?? '',
    expiryDate: fields.expiryDate.value,
    source,
    dateType: fields.dateType.value,
    needsNameCheck: fields.itemName.value === null || fields.itemName.confidence !== 'high',
    needsDateCheck: fields.expiryDate.value === null || fields.expiryDate.confidence !== 'high',
  };
}

/**
 * Which of the two fields the model actually came back with.
 *
 * A `200` is not the same as a useful read — the proxy can answer successfully
 * with null for everything. This turns "how did the read go" into one greppable
 * word, and the four cases call for different responses: `both` is the product
 * working, `neither` is the photo or the model, and the one-sided cases usually
 * mean the name and the date were not both legible in the same shot.
 *
 * Deliberately the same four words the proxy logs, so a scan reads the same on
 * the phone and on the server.
 */
export type ReadQuality = 'both' | 'name-only' | 'date-only' | 'neither';

export function describeRead(fields: ExtractedFields): ReadQuality {
  const name = fields.itemName.value !== null;
  const date = fields.expiryDate.value !== null;
  if (name && date) return 'both';
  if (name) return 'name-only';
  if (date) return 'date-only';
  return 'neither';
}

/**
 * Values the proxy sent that this build then refused.
 *
 * `readFields` re-validates everything the server already normalised — a second
 * line, because the app and the proxy deploy independently. That guard is
 * right, and it is also silent: a date this build discarded and a date the
 * model never read both arrive at the editor as nothing, which are completely
 * different problems. One is our own mapping throwing away usable output.
 *
 * This should always return an empty list. If it ever does not, the two
 * deployments disagree about the contract, and that is worth knowing
 * immediately rather than reading as a bad photo. Names the field only — never
 * the value, which would put the item name in the log.
 */
export function mappingDrops(body: unknown, fields: ExtractedFields | null): string[] {
  if (fields === null || typeof body !== 'object' || body === null) return [];

  const sent = (body as { fields?: Record<string, { value?: unknown }> }).fields;
  if (!sent) return [];

  const supplied = (key: string): boolean => {
    const value = sent[key]?.value;
    return typeof value === 'string' && value.trim().length > 0;
  };

  const drops: string[] = [];
  if (supplied('itemName') && fields.itemName.value === null) drops.push('name');
  if (supplied('expiryDate') && fields.expiryDate.value === null) drops.push('date');
  return drops;
}

/**
 * How the Review & Save screen introduces itself, given what the scan returned.
 *
 * Lives here rather than in the screen so the offline suite can hold it to the
 * response contract: the four variants are a direct function of the prefill,
 * and getting one wrong tells the user we read something we did not.
 *
 * The order matters. A photo that yielded *neither* field is the same situation
 * as an outright failure — the model returned a well-formed 200 saying it could
 * see nothing — and it has to be checked before the single-field cases, which
 * each promise that the other field came back. Without that branch, an empty
 * read fell through to "We got the date but not the item" while showing no
 * date at all.
 */
export function reviewCopy(
  source: ItemSource,
  hasNotice: boolean,
  hasName: boolean,
  hasDate: boolean,
): { title: string; note: string } {
  if (source === 'manual') {
    return { title: 'Add an item', note: 'The same two fields, nothing filled in.' };
  }
  if (hasNotice || (!hasName && !hasDate)) {
    return {
      title: "We couldn't read that one",
      note: 'Type it in instead, or retake the photo.',
    };
  }
  if (!hasName) {
    return {
      title: 'Almost there',
      note: 'We got the date but not the item. Name it and save.',
    };
  }
  if (!hasDate) {
    return {
      title: 'Almost there',
      note: 'We got the item but not the date. Add it and save.',
    };
  }
  return { title: "Here's what we found", note: 'Have a quick look, then save.' };
}

/** The editor's starting state when there is nothing to prefill. */
export function emptyPrefill(source: ItemSource, notice?: string): AddScreenPrefill {
  return {
    name: '',
    expiryDate: null,
    source,
    dateType: 'unknown',
    needsNameCheck: false,
    needsDateCheck: false,
    notice,
  };
}
