import {
  differenceInCalendarDays,
  format,
  parseISO,
  startOfDay,
} from 'date-fns';

/** Return today as a YYYY-MM-DD string */
export function todayString(): string {
  return format(new Date(), 'yyyy-MM-dd');
}

/** Parse a YYYY-MM-DD string to a Date at midnight local time */
export function parseDate(dateStr: string): Date {
  return startOfDay(parseISO(dateStr));
}

/** Format a Date for display, e.g. "28 Mar 2026" */
export function formatDisplay(date: Date): string {
  return format(date, 'd MMM yyyy');
}

/** Format a Date to a YYYY-MM-DD storage string */
export function formatStorage(date: Date): string {
  return format(date, 'yyyy-MM-dd');
}

/** Days from today until the use-by date. Negative = past it. */
export function getDaysUntilDue(dueDate: Date): number {
  const today = startOfDay(new Date());
  return differenceInCalendarDays(dueDate, today);
}
