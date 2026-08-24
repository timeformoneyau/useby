export type ItemSource = 'manual' | 'photo';

/**
 * A single tracked item.
 *
 * Ported from since-fresh's `SinceItem`, reduced to expiry tracking only.
 * That repo modelled two kinds of reminder — a recurring "last done + repeat
 * interval" for life admin (dentist, air filter), and a one-shot expiry date
 * for food — with the expiry date taking priority when both were present.
 *
 * UseBy only ever does the second one, so `expiryDate` is required rather
 * than nullable, and the recurring half (`lastDoneDate`, `history`,
 * `repeatValue`, `repeatUnit`) plus `category` are gone entirely.
 */
export interface UseByItem {
  id: string;
  name: string;
  /** ISO date string (YYYY-MM-DD). The due date, directly. */
  expiryDate: string;
  source: ItemSource;
  createdAt: string;
  updatedAt: string;
}

/**
 * Urgency ladder, ordered from most to least time remaining.
 *
 * Replaces since-fresh's labels, which were phrased for recurring chores
 * ("It's been a while", "Long overdue") and read wrong for food.
 */
export type StatusLabel =
  | 'Fresh'
  | 'Use soon'
  | 'Use today'
  | 'Past use by'
  | 'Well past';

export interface ItemStatus {
  label: StatusLabel;
  /** Days from today until the use-by date. Negative = already past it. */
  daysUntilDue: number;
  dueDate: Date;
}

/**
 * How the packaging labelled the date, as classified by the proxy.
 *
 * "Use by" is a safety deadline; "best before" is a quality one. `unknown` is a
 * legitimate value, not an error: a bare `EXP`, `EXPIRY` or an unreadable label
 * genuinely does not say which kind of date it is, so the proxy preserves the
 * date and declines to guess the meaning (decision D1 on the Build Plan).
 *
 * NOTE — Phase 3 boundary. This currently lives only in the review/prefill
 * model: the user can see and correct it before saving, but `UseByItem` does
 * not carry it and it is not written to storage. Persisting it properly is
 * Phase 3 schema work (decision D2), and the date-aware wording that consumes
 * it is Phase 4. Deliberately not widened here.
 */
export type DateType = 'use_by' | 'best_before' | 'unknown';

/** Per-field certainty reported by the proxy. Never surfaced to the user as a number. */
export type Confidence = 'high' | 'medium' | 'low';

/** One extracted field as the proxy returns it. */
export interface ExtractedField<T> {
  value: T | null;
  confidence: Confidence;
}

/** The `fields` object of a successful `POST /api/parse-expiry` response. */
export interface ExtractedFields {
  itemName: ExtractedField<string>;
  /** ISO YYYY-MM-DD, already normalised server-side. Null when unreadable. */
  expiryDate: ExtractedField<string>;
  dateType: { value: DateType; confidence: Confidence };
}

/** Prefill passed from CaptureScreen into AddItemScreen after a capture. */
export interface AddScreenPrefill {
  name: string;
  expiryDate: string | null;
  source: ItemSource;
  /**
   * What the packaging said, as read or as defaulted. Transient — see the
   * DateType note above; it is not persisted with the item.
   */
  dateType: DateType;
  /** Draw the eye to the name field. Set when the read was not confident. */
  needsNameCheck: boolean;
  /** Draw the eye to the date field. Set when the read was missing or not confident. */
  needsDateCheck: boolean;
  /** Explains a failed or partial scan. Shown as a banner; never a raw server string. */
  notice?: string;
}

export type RootStackParamList = {
  Main: undefined;
  Add: { prefill?: AddScreenPrefill } | undefined;
  Capture: undefined;
};
