import { UseByItem, StatusLabel, ItemStatus } from '../types';
import { parseDate, getDaysUntilDue } from './dateUtils';

/**
 * Days-remaining thresholds for the urgency ladder.
 *
 * since-fresh derived its "coming up" window from the item's repeat interval
 * (a yearly chore warned earlier than a weekly one) and fell back to a fixed
 * 3 days for scanned food. With repeat intervals gone there is nothing to
 * derive from, so the whole ladder is fixed and tuned for short shelf life.
 */
const FRESH_ABOVE_DAYS = 3;
const WELL_PAST_BELOW_DAYS = -7;

function labelForDaysUntilDue(daysUntilDue: number): StatusLabel {
  if (daysUntilDue > FRESH_ABOVE_DAYS) return 'Fresh';
  if (daysUntilDue > 0) return 'Use soon';
  if (daysUntilDue === 0) return 'Use today';
  if (daysUntilDue > WELL_PAST_BELOW_DAYS) return 'Past use by';
  return 'Well past';
}

export function computeItemStatus(item: UseByItem): ItemStatus {
  const dueDate = parseDate(item.expiryDate);
  const daysUntilDue = getDaysUntilDue(dueDate);
  return { label: labelForDaysUntilDue(daysUntilDue), daysUntilDue, dueDate };
}

/** Sort order index — lower = shown first */
export function statusSortOrder(label: StatusLabel): number {
  switch (label) {
    case 'Well past':   return 0;
    case 'Past use by': return 1;
    case 'Use today':   return 2;
    case 'Use soon':    return 3;
    case 'Fresh':       return 4;
    default:            return 5;
  }
}

/**
 * Urgency order: most urgent first.
 *
 * since-fresh nested this inside per-category sections. Categories are gone,
 * so the list is flat and this ordering alone decides what the user sees at
 * the top.
 */
export function sortItems(items: UseByItem[]): UseByItem[] {
  return [...items].sort((a, b) => {
    const sa = computeItemStatus(a);
    const sb = computeItemStatus(b);

    const orderDiff = statusSortOrder(sa.label) - statusSortOrder(sb.label);
    if (orderDiff !== 0) return orderDiff;

    // Within a band, the closest to (or furthest past) the date comes first.
    if (sa.daysUntilDue !== sb.daysUntilDue) return sa.daysUntilDue - sb.daysUntilDue;

    return a.name.localeCompare(b.name);
  });
}

/** Secondary line text shown in the item card */
export function secondaryLine(status: ItemStatus): string {
  const { daysUntilDue } = status;
  const absDays = Math.abs(daysUntilDue);

  if (daysUntilDue === 0) return 'Use by today';
  if (daysUntilDue === 1) return 'Use by tomorrow';
  if (daysUntilDue > 1) return `${daysUntilDue} days left`;
  if (daysUntilDue === -1) return '1 day past';
  return `${absDays} days past`;
}
