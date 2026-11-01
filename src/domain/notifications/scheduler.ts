/**
 * Keeps the OS's pending expiry reminders equal to what `policy.ts` says they
 * should be.
 *
 * One operation, `sync()`: read the saved items and the preferences, plan the
 * reminders, read what the OS holds, and apply the difference. Every lifecycle
 * event — app start, app returning to the foreground, an item saved, edited,
 * used or deleted, a preference changed — calls the same thing. There is no
 * incremental bookkeeping to drift: whatever happened, the next sync makes the
 * OS match the saved items again. That is also what makes a time-zone change
 * safe: fire times are re-planned in the new local time on the next sync and
 * any that moved are replaced.
 *
 * **Serialised.** Syncs never overlap. A sync requested while one is running is
 * coalesced into a single follow-up run, so a burst of saves costs at most two
 * passes and two passes can never interleave their cancel/schedule calls.
 *
 * **Read-only on items.** It reads the saved items through the injected
 * `loadItems` and writes nothing back. Item persistence is untouched.
 *
 * Like `pending.ts` and `photos.ts`, a factory over injected dependencies with
 * no value imports beyond the pure policy, so the offline suite drives it end
 * to end. The expo-notifications wiring is `reminders.ts`.
 */
import {
  isOurReminderId,
  planReminders,
  reconcilePlan,
  type NotificationPrefs,
  type PlannedReminder,
  type ReminderItem,
  type ScheduledReminder,
} from './policy.ts';

export type PermissionState = 'granted' | 'denied' | 'undetermined';

/** What the scheduler needs from the platform. */
export interface ReminderPlatform {
  getPermission(): Promise<PermissionState>;
  listScheduled(): Promise<ScheduledReminder[]>;
  schedule(reminder: PlannedReminder): Promise<void>;
  cancel(id: string): Promise<void>;
}

export interface SyncResult {
  /** Why nothing was scheduled, if nothing could be. */
  state: 'scheduled' | 'off' | 'no-permission' | 'failed';
  /** Our reminders pending with the OS after this sync. */
  pending: number;
  cancelled: number;
  scheduled: number;
}

export interface ReminderScheduler {
  /** Bring the OS into line. Resolves once this request's pass has run. */
  sync(reason: string): Promise<SyncResult>;
}

export function createReminderScheduler(deps: {
  platform: ReminderPlatform;
  loadItems: () => Promise<readonly ReminderItem[]>;
  loadPrefs: () => Promise<NotificationPrefs>;
  now?: () => number;
  /** Counts and reasons only — never an item name. */
  log?: (line: Record<string, unknown>) => void;
}): ReminderScheduler {
  const { platform, loadItems, loadPrefs, now = Date.now, log = () => {} } = deps;

  let running: Promise<SyncResult> | null = null;
  let queued: Promise<SyncResult> | null = null;

  async function cancelAllOurs(): Promise<number> {
    const scheduled = await platform.listScheduled();
    let cancelled = 0;
    for (const s of scheduled) {
      if (!isOurReminderId(s.id)) continue;
      await platform.cancel(s.id);
      cancelled += 1;
    }
    return cancelled;
  }

  async function pass(reason: string): Promise<SyncResult> {
    try {
      const prefs = await loadPrefs();

      if (!prefs.enabled) {
        const cancelled = await cancelAllOurs();
        const result: SyncResult = { state: 'off', pending: 0, cancelled, scheduled: 0 };
        log({ reason, ...result });
        return result;
      }

      // Permission can be withdrawn in system settings at any time. Without it
      // nothing would be shown, so hold nothing — the next sync after it is
      // granted again schedules the lot.
      const permission = await platform.getPermission();
      if (permission !== 'granted') {
        const cancelled = await cancelAllOurs();
        const result: SyncResult = { state: 'no-permission', pending: 0, cancelled, scheduled: 0 };
        log({ reason, ...result, permission });
        return result;
      }

      const items = await loadItems();
      const desired = planReminders(items, prefs, now());
      const current = await platform.listScheduled();
      const plan = reconcilePlan(desired, current);

      for (const id of plan.cancel) await platform.cancel(id);
      for (const reminder of plan.schedule) await platform.schedule(reminder);

      const result: SyncResult = {
        state: 'scheduled',
        pending: desired.length,
        cancelled: plan.cancel.length,
        scheduled: plan.schedule.length,
      };
      log({ reason, ...result, items: items.length });
      return result;
    } catch (e) {
      // A platform call failed part-way. Nothing is left half-trusted: the
      // next sync re-reads the OS and repairs whatever this one did not finish.
      const result: SyncResult = { state: 'failed', pending: 0, cancelled: 0, scheduled: 0 };
      log({ reason, ...result, err: e instanceof Error ? e.message.slice(0, 120) : typeof e });
      return result;
    }
  }

  return {
    sync(reason) {
      if (!running) {
        running = pass(reason).finally(() => {
          running = null;
        });
        return running;
      }
      // One already running: everything requested meanwhile shares a single
      // follow-up pass, which starts once the current one has finished and so
      // sees every change made in the meantime.
      if (!queued) {
        const after = running;
        queued = after.then(() => {
          queued = null;
          running = pass(`${reason}+coalesced`).finally(() => {
            running = null;
          });
          return running;
        });
      }
      return queued;
    },
  };
}
