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
import type { DateType } from '../../types';
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
 * What the packaging called the date, in the tense that matches where it sits.
 *
 * `unknown` becomes a bare "Date": no more than the pack told us. A
 * best-before item is never described as past a safety deadline, which is the
 * whole reason the distinction is carried from scan time (D1/D2).
 */
export function typeWord(dateType: DateType | undefined, isPast: boolean): string {
  const type = dateType ?? 'unknown';
  if (isPast) {
    if (type === 'use_by') return 'Past Use By';
    if (type === 'best_before') return 'Best Before passed';
    return 'Date passed';
  }
  if (type === 'use_by') return 'Use By';
  if (type === 'best_before') return 'Best Before';
  return 'Date';
}

/** "24 Aug" — the calendar date, kept as a footnote to the time left. */
export function shortDate(date: Date): string {
  return format(date, 'd MMM');
}

/** "1 Sep 2026" — the fuller form, for the editor's preview line. */
export function longDate(date: Date): string {
  return format(date, 'd MMM yyyy');
}

/** The row's right-hand column: what the pack said, and when. */
export function rowSubtitle(
  dateType: DateType | undefined,
  dueDate: Date,
  daysUntilDue: number,
): string {
  return `${typeWord(dateType, daysUntilDue < 0)} · ${shortDate(dueDate)}`;
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
