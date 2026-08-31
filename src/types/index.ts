export type ItemSource = 'manual' | 'photo';

/**
 * How the packaging labelled the date, as classified by the proxy.
 *
 * "Use by" is a safety deadline; "best before" is a quality one. `unknown` is a
 * legitimate value, not an error: a bare `EXP`, `EXPIRY` or an unreadable label
 * genuinely does not say which kind of date it is, so the proxy preserves the
 * date and declines to guess the meaning (decision D1 on the Build Plan).
 *
 * Persisted locally on `UseByItem` so the list can describe a date truthfully
 * rather than calling every item "Use by". Syncing it to other devices is
 * still Phase 3 schema work (decision D2).
 */
export type DateType = 'use_by' | 'best_before' | 'unknown';

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
  /**
   * What the packaging called the date, as read at scan time or set by hand.
   *
   * Optional because records written before this field existed simply do not
   * have it; those read back as `undefined` and are presented as `unknown`,
   * which is the honest reading — we genuinely do not know what their pack
   * said. No migration is needed for that reason.
   *
   * Local persistence only. The Supabase schema that carries this to other
   * devices is still Phase 3 work (D2).
   */
  dateType?: DateType;
  /**
   * Filename of the retained scan photo, inside the app's photos directory.
   *
   * A **filename, never an absolute URI**, and that is the whole point of the
   * field's shape. A `file:///…` path embeds the app container directory, and
   * on iOS that directory changes between installs and can change across
   * updates — every stored path would silently start pointing at nothing. The
   * name is resolved against the photos directory at render time instead.
   *
   * Optional because most items do not have one: manual adds never do, and
   * records written before this field existed read back as `undefined`. Both
   * render with no photo block, which is the honest result rather than a
   * degraded one. No migration is needed for the same reason `dateType` needed
   * none at v2.
   *
   * Local only. This never leaves the device.
   */
  photo?: string;
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



/** Per-field certainty reported by the proxy. Never surfaced to the user as a number. */
export type Confidence = 'high' | 'medium' | 'low';

/** One extracted field as the proxy returns it. */
export interface ExtractedField<T> {
  value: T | null;
  confidence: Confidence;
}

/**
 * What the model reported seeing, before it interpreted any of it.
 *
 * Kept separate from the fields above because the distinction is the whole
 * point: `dateText` is a claim about *characters printed on a pack*, which the
 * model can answer honestly and which application code can then check. The
 * normalised `expiryDate` beside it is the model's own conclusion about what
 * those characters mean — a judgement, and one that carries no record of how it
 * was reached. `04/09/26` normalised to a September date and to an April date
 * look identical once the characters are gone.
 *
 * Optional throughout. A proxy deployment that predates this block simply does
 * not send it, and the app must keep working exactly as before — the shadow
 * gate then reports that there was no evidence to judge on, which is the
 * truthful answer rather than an error.
 *
 * Never rendered. Recognition still drives the editor from the fields above.
 */
export interface ObservedText {
  /** The date exactly as printed, e.g. `04 SEP 26`. Null if not fully legible. */
  dateText: string | null;
  /** Wording printed with that date, e.g. `USE BY`. Null if there was none. */
  dateLabelText: string | null;
  /** Every other date-like string visible on the pack. */
  otherDateTexts: string[];
}

/** The `fields` object of a successful `POST /api/parse-expiry` response. */
export interface ExtractedFields {
  itemName: ExtractedField<string>;
  /** ISO YYYY-MM-DD, already normalised server-side. Null when unreadable. */
  expiryDate: ExtractedField<string>;
  dateType: { value: DateType; confidence: Confidence };
  /** Verbatim observations, when the proxy supplies them. See `ObservedText`. */
  observed?: ObservedText;
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
  /**
   * Review & Save.
   *
   * `prefill` is unchanged and still carries the editor's whole starting state,
   * so manual entry and the scan-review path stay one contract. `scanId` is
   * additive and says only "this editor is showing a pending scan": it lets
   * Save retire that draft and offers Discard, and its absence is what makes a
   * manual add indistinguishable from before.
   *
   * The draft is deliberately *not* looked up by id instead — passing the
   * prefill keeps the screen a pure function of its parameters, so a draft
   * retired mid-edit cannot empty the form underneath the user.
   */
  Add: { prefill?: AddScreenPrefill; scanId?: string } | undefined;
  /**
   * Camera.
   *
   * `replacing` is a retake: the next photo taken belongs to that existing
   * pending draft and supersedes it, rather than starting a new one. Absent for
   * an ordinary trip to the camera, which is what keeps normal capture
   * unchanged. It is consumed by the first shutter press and ignored after
   * that — a retake replaces one draft, and the shots that follow are new
   * items like any others.
   */
  Capture: { replacing?: string } | undefined;
  /**
   * A saved item, opened from its row on Home.
   *
   * Carries the id and not the item: Home already re-reads storage on focus, so
   * passing the record would mean two copies of the same item that can disagree
   * the moment either screen changes one. The screen loads what it shows.
   */
  ItemDetail: { itemId: string };
};
