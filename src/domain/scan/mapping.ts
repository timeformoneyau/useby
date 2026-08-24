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
} from '../../types';

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
  | { ok: true; prefill: AddScreenPrefill }
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

  return {
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
