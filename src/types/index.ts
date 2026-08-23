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

/** Prefill passed from CaptureScreen into AddItemScreen after a capture. */
export interface AddScreenPrefill {
  name: string;
  expiryDate: string | null;
  source: ItemSource;
}

export type RootStackParamList = {
  Main: undefined;
  Add: { prefill?: AddScreenPrefill } | undefined;
  Capture: undefined;
};
