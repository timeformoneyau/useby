/**
 * Expiry reminders: what should be scheduled, decided without touching the OS.
 *
 * Everything here is pure and has no value imports, so the offline suite
 * loads it directly and pins every rule: which reminders exist for an item,
 * when each fires in local time, what it says, which fall inside the rolling
 * window, and what has to change to make the OS match.
 *
 * **Three reminder types.** For an item with a Use By date D:
 *
 * - `approaching` — the calendar day before D. On by default.
 * - `due` — D itself. On by default.
 * - `overdue` — the calendar day after D. Off by default (opt-in).
 *
 * Each fires at the user's chosen local time (default 9:00 am).
 *
 * **Calendar days, not 24-hour steps.** "The day before" is computed on the
 * local calendar (`new Date(y, m, d - 1, hh, mm)`), never by subtracting
 * 86 400 000 ms. Across a daylight-saving change a day is 23 or 25 hours long,
 * and the millisecond version would fire an hour early or late — or on the
 * wrong date entirely near midnight. The JS Date constructor normalises local
 * fields through the platform's time-zone rules, which is exactly the
 * behaviour wanted. A reminder time that falls inside a spring-forward gap is
 * moved forward by the platform, never dropped.
 *
 * **Wording.** Informative, never a safety verdict: it says when the Use By
 * date is, not whether food is safe. It always says "Use By", whatever the
 * packaging printed — the product's one date concept. The stored `dateType`
 * (use_by / best_before / unknown) is internal evidence and is deliberately
 * not consulted here, so no reminder can make a claim the packaging did not.
 *
 * **Rolling window.** Android allows an app a few hundred pending alarms and
 * iOS 64 pending notifications, so the app never tries to schedule every
 * future reminder. Only reminders firing within `WINDOW_DAYS` are scheduled,
 * soonest first, capped at `MAX_SCHEDULED`. The window is re-planned whenever
 * the app starts or comes to the foreground and after every item change, so it
 * rolls forward with use. A reminder further out than the window is scheduled
 * the next time the app is opened inside it.
 */

export type ReminderKind = 'approaching' | 'due' | 'overdue';

export const REMINDER_KINDS: readonly ReminderKind[] = ['approaching', 'due', 'overdue'];

export interface NotificationPrefs {
  /** Master switch. Off until the user turns reminders on (and grants permission). */
  enabled: boolean;
  approaching: boolean;
  due: boolean;
  overdue: boolean;
  /** Local time of day, 24-hour. */
  hour: number;
  minute: number;
}

/**
 * Reminders start off: the OS permission prompt is shown only when the user
 * turns them on, never on launch. Once on, Approaching and Due today are
 * active; Overdue is opt-in. 9:00 am local.
 */
export const DEFAULT_PREFS: NotificationPrefs = {
  enabled: false,
  approaching: true,
  due: true,
  overdue: false,
  hour: 9,
  minute: 0,
};

/** How far ahead reminders are actually handed to the OS. */
export const WINDOW_DAYS = 30;

/**
 * Most reminders pending with the OS at once. Below iOS's hard 64 and far below
 * Android's per-app alarm ceiling, leaving room for anything else the OS keeps.
 */
export const MAX_SCHEDULED = 60;

/** Prefix of every identifier this module owns, so reconciliation never touches anything else. */
export const ID_PREFIX = 'useby.expiry.';

/** Calendar offset from the Use By date, in days. */
const OFFSET: Record<ReminderKind, number> = { approaching: -1, due: 0, overdue: 1 };

/** The minimal shape of a saved item this module needs. */
export interface ReminderItem {
  id: string;
  name: string;
  expiryDate: string;
}

export interface PlannedReminder {
  /** Stable per item and kind: scheduling it twice replaces, never duplicates. */
  id: string;
  itemId: string;
  kind: ReminderKind;
  /** Epoch ms of the local fire time. */
  fireAt: number;
  title: string;
  body: string;
}

/** What the OS says is pending, reduced to what reconciliation compares. */
export interface ScheduledReminder {
  id: string;
  fireAt: number | null;
  body: string | null;
}

export function reminderId(itemId: string, kind: ReminderKind): string {
  return `${ID_PREFIX}${itemId}.${kind}`;
}

export function isOurReminderId(id: string): boolean {
  return id.startsWith(ID_PREFIX);
}

/** Parse YYYY-MM-DD into calendar parts, rejecting anything that is not a real date. */
export function parseCalendarDate(
  value: string,
): { year: number; month: number; day: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  // Round-trip through the calendar so 2026-02-30 is refused, not rolled over.
  const probe = new Date(year, month - 1, day);
  if (probe.getFullYear() !== year || probe.getMonth() !== month - 1 || probe.getDate() !== day) {
    return null;
  }
  return { year, month, day };
}

/**
 * When a reminder of `kind` for a Use By date fires, in local time, or `null`
 * for a date that does not parse.
 */
export function reminderFireTime(
  expiryDate: string,
  kind: ReminderKind,
  prefs: Pick<NotificationPrefs, 'hour' | 'minute'>,
): Date | null {
  const date = parseCalendarDate(expiryDate);
  if (!date) return null;
  return new Date(
    date.year,
    date.month - 1,
    date.day + OFFSET[kind],
    prefs.hour,
    prefs.minute,
    0,
    0,
  );
}

/**
 * The words. "Use By" whatever the pack said; when, never whether it is safe.
 * The item name is used exactly as the user saved it.
 */
export function reminderText(name: string, kind: ReminderKind): { title: string; body: string } {
  const item = name.trim() || 'item';
  switch (kind) {
    case 'approaching':
      return { title: 'UseBy', body: `Your ${item} reaches its Use By date tomorrow.` };
    case 'due':
      return { title: 'UseBy', body: `Your ${item} reaches its Use By date today.` };
    case 'overdue':
      return { title: 'UseBy', body: `Your ${item} passed its Use By date yesterday.` };
  }
}

export function enabledKinds(prefs: NotificationPrefs): ReminderKind[] {
  if (!prefs.enabled) return [];
  return REMINDER_KINDS.filter((kind) => prefs[kind]);
}

/**
 * Every reminder that should be pending with the OS right now.
 *
 * Skips: reminders whose time has passed, items with no valid date, kinds the
 * user has switched off, and everything beyond the window. Soonest first, then
 * capped — so if the cap bites, it is the furthest-away reminders that wait.
 */
export function planReminders(
  items: readonly ReminderItem[],
  prefs: NotificationPrefs,
  now: number,
  options: { windowDays?: number; max?: number } = {},
): PlannedReminder[] {
  const kinds = enabledKinds(prefs);
  if (kinds.length === 0) return [];

  const windowDays = options.windowDays ?? WINDOW_DAYS;
  const max = options.max ?? MAX_SCHEDULED;
  const nowDate = new Date(now);
  // The window's end on the local calendar, for the same reason as above.
  const horizon = new Date(
    nowDate.getFullYear(),
    nowDate.getMonth(),
    nowDate.getDate() + windowDays,
    23,
    59,
    59,
    999,
  ).getTime();

  const planned: PlannedReminder[] = [];
  const seen = new Set<string>();

  for (const item of items) {
    for (const kind of kinds) {
      const fire = reminderFireTime(item.expiryDate, kind, prefs);
      if (!fire) continue;
      const fireAt = fire.getTime();
      if (fireAt <= now || fireAt > horizon) continue;

      const id = reminderId(item.id, kind);
      if (seen.has(id)) continue; // two records with one id: one reminder
      seen.add(id);

      planned.push({ id, itemId: item.id, kind, fireAt, ...reminderText(item.name, kind) });
    }
  }

  planned.sort((a, b) => a.fireAt - b.fireAt || a.id.localeCompare(b.id));
  return planned.slice(0, max);
}

/**
 * What to change so the OS holds exactly `desired`.
 *
 * Only identifiers this module owns are considered, so nothing else the app
 * or the OS has scheduled is touched. A reminder already pending with the same
 * time and wording is left alone; one whose time or wording changed (a date
 * edit, a rename, a new reminder time, a time-zone change) is replaced; one no
 * longer wanted (Used, Deleted, a kind switched off, reminders off) is
 * cancelled.
 */
export function reconcilePlan(
  desired: readonly PlannedReminder[],
  scheduled: readonly ScheduledReminder[],
): { cancel: string[]; schedule: PlannedReminder[] } {
  const ours = scheduled.filter((s) => isOurReminderId(s.id));
  const pending = new Map<string, ScheduledReminder>();
  const cancel = new Set<string>();

  for (const s of ours) {
    // The OS should never hold two with one identifier; if it somehow does,
    // clear it and schedule once.
    if (pending.has(s.id)) cancel.add(s.id);
    else pending.set(s.id, s);
  }

  const wanted = new Map(desired.map((d) => [d.id, d]));
  for (const id of pending.keys()) if (!wanted.has(id)) cancel.add(id);

  const schedule: PlannedReminder[] = [];
  for (const d of desired) {
    const current = pending.get(d.id);
    const unchanged =
      current &&
      !cancel.has(d.id) &&
      current.fireAt === d.fireAt &&
      current.body === d.body;
    if (unchanged) continue;
    if (current) cancel.add(d.id);
    schedule.push(d);
  }

  return { cancel: [...cancel], schedule };
}

/* ---------------------------------------------------------------------------
 * Preferences on disk.
 * ------------------------------------------------------------------------ */

function isHour(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 23;
}

function isMinute(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 59;
}

/**
 * Stored preferences, defended. Anything missing or malformed falls back to
 * the default for that field rather than throwing or switching reminders on.
 */
export function parsePrefs(raw: string | null): NotificationPrefs {
  if (!raw) return { ...DEFAULT_PREFS };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { ...DEFAULT_PREFS };
  }
  if (typeof value !== 'object' || value === null) return { ...DEFAULT_PREFS };
  const v = value as Record<string, unknown>;
  const bool = (key: keyof NotificationPrefs) =>
    typeof v[key] === 'boolean' ? (v[key] as boolean) : (DEFAULT_PREFS[key] as boolean);
  return {
    enabled: bool('enabled'),
    approaching: bool('approaching'),
    due: bool('due'),
    overdue: bool('overdue'),
    hour: isHour(v.hour) ? v.hour : DEFAULT_PREFS.hour,
    minute: isMinute(v.minute) ? v.minute : DEFAULT_PREFS.minute,
  };
}

/* ---------------------------------------------------------------------------
 * The time control.
 * ------------------------------------------------------------------------ */

export const TIME_STEP_MINUTES = 15;

/** Move the reminder time by whole steps, wrapping round midnight. */
export function stepTime(
  prefs: Pick<NotificationPrefs, 'hour' | 'minute'>,
  steps: number,
): { hour: number; minute: number } {
  const day = 24 * 60;
  const current = prefs.hour * 60 + prefs.minute;
  // Snap to the step grid first so an odd stored minute still lands cleanly.
  const snapped = Math.round(current / TIME_STEP_MINUTES) * TIME_STEP_MINUTES;
  const next = (((snapped + steps * TIME_STEP_MINUTES) % day) + day) % day;
  return { hour: Math.floor(next / 60), minute: next % 60 };
}

/** "9:00 am", "12:30 pm", "12:00 am". */
export function formatTime(hour: number, minute: number): string {
  const suffix = hour < 12 ? 'am' : 'pm';
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12}:${String(minute).padStart(2, '0')} ${suffix}`;
}
