/**
 * How an item reads on screen.
 *
 * This is a presentation layer over `statusUtils`, not a replacement for it.
 * The five-band urgency ladder (`Fresh` … `Well past`) still drives sorting and
 * is left untouched; what changes here is only what the user sees. The design
 * groups into four visible buckets and lets the row itself carry the precise
 * distance — "Past by 9 days" rather than a separate "Well past" section — so
 * the underlying relative-time derivation stays available for anything that
 * needs it (notifications, later filtering) without being flattened to match
 * the visuals.
 *
 * Pure and free of React Native so the offline suite can exercise it.
 */
import { format } from 'date-fns';
import type { DerivedItem } from './types';

export type GroupKey = 'past' | 'today' | 'soon' | 'later';

/**
 * Bucket boundaries, matching the artboard: anything before today, today
 * itself, the next three days, and everything beyond.
 */
export function groupFor(daysUntilDue: number): GroupKey {
  if (daysUntilDue < 0) return 'past';
  if (daysUntilDue === 0) return 'today';
  if (daysUntilDue <= 3) return 'soon';
  return 'later';
}

/**
 * The artboard labels the last bucket "Later this week", which is wrong: it
 * catches everything more than three days out, including an item a fortnight
 * away. "Later" is the same bucket described accurately.
 */
const GROUP_LABELS: Record<GroupKey, string> = {
  past: 'Past their date',
  today: 'Today',
  soon: 'Use soon',
  later: 'Later',
};

export function groupLabel(key: GroupKey): string {
  return GROUP_LABELS[key];
}

const GROUP_ORDER: GroupKey[] = ['past', 'today', 'soon', 'later'];

/** Time left, as the row's headline. */
export function heroText(daysUntilDue: number): string {
  if (daysUntilDue < 0) {
    const past = Math.abs(daysUntilDue);
    return past === 1 ? 'Past by 1 day' : `Past by ${past} days`;
  }
  if (daysUntilDue === 0) return 'Today';
  return daysUntilDue === 1 ? '1 day left' : `${daysUntilDue} days left`;
}

/**
 * What the app calls an item's date, in the tense that matches where it sits.
 *
 * **One concept, and it is always Use By.** The app used to say "Use By",
 * "Best Before" or a bare "Date" depending on what the packaging printed. That
 * was accurate and it was the wrong thing to show: three names for one idea,
 * asking the reader to hold a food-safety distinction in their head before they
 * can answer "what do I need to use first?" — which is the only question this
 * screen exists to answer.
 *
 * **This function no longer takes a `DateType`, and that is the point.** The
 * distinction is still recorded on the item and still matters internally, so a
 * rule kept only in copy would drift back the first time someone added a branch
 * "just for past-dated items". Removing the parameter makes it impossible to
 * reintroduce here without a deliberate change of shape.
 *
 * Where the distinction has real consequences — anything that would tell
 * someone food is no longer safe — it must be read from the item's `dateType`
 * and `dateUserSet` directly, not inferred from what this returns. No such
 * feature exists today, and this comment is here so the next one does not
 * assume the word on screen carries the semantics.
 */
export function dateWord(isPast: boolean): string {
  return isPast ? 'Past Use By' : 'Use By';
}

/** "24 Aug" — the calendar date, kept as a footnote to the time left. */
export function shortDate(date: Date): string {
  return format(date, 'd MMM');
}

/** "1 Sep 2026" — the fuller form, for the editor's preview line. */
export function longDate(date: Date): string {
  return format(date, 'd MMM yyyy');
}

/** The row's right-hand column: the item's date, and what to call it. */
export function rowSubtitle(dueDate: Date, daysUntilDue: number): string {
  return `${dateWord(daysUntilDue < 0)} · ${shortDate(dueDate)}`;
}

export interface ItemGroup {
  key: GroupKey;
  label: string;
  count: number;
  data: DerivedItem[];
}

/**
 * Split the already-sorted list into the four visible groups.
 *
 * Order within a group is whatever `sortItems` decided, so the urgency
 * ordering the list screen depends on is preserved exactly. Empty groups are
 * dropped rather than shown as empty headings.
 */
export function groupItems(items: DerivedItem[]): ItemGroup[] {
  return GROUP_ORDER.map((key) => {
    const data = items.filter((item) => groupFor(item.status.daysUntilDue) === key);
    return { key, label: groupLabel(key), count: data.length, data };
  }).filter((group) => group.count > 0);
}

/**
 * The header's running count. Framed as what needs attention rather than as an
 * inventory total — the screen answers "what should I use next?", not "what do
 * I own?".
 */
export function headerCount(items: DerivedItem[]): string {
  const soon = items.filter((item) => item.status.daysUntilDue <= 3).length;
  if (soon > 0) return `${soon} need using soon`;
  return items.length === 1 ? '1 tracked' : `${items.length} tracked`;
}
