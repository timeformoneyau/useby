/**
 * The app's one reminder scheduler, wired to expo-notifications.
 *
 * Every decision is in `policy.ts` and `scheduler.ts`; this file is the plug:
 * the Android channel, the foreground presentation, permission, and the four
 * OS calls the scheduler makes. Local notifications only — no push token is
 * ever requested and nothing leaves the device.
 *
 * Triggers are absolute DATE triggers at the planned local time. On Android
 * they are alarms the OS may defer under Doze or battery optimisation, so a
 * reminder can arrive a little after its time; delivery is the OS's to make,
 * and the app does not promise more than that. Pending alarms are restored
 * after a reboot by expo-notifications' own boot receiver.
 */
import { Linking, Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import { getDerivedItems } from '../items/service';
import { createReminderScheduler, type PermissionState, type ReminderPlatform } from './scheduler';
import { loadNotificationPrefs } from './prefsStore';
import type { PlannedReminder, ScheduledReminder } from './policy';

export const CHANNEL_ID = 'expiry-reminders';

function permissionState(status: Notifications.NotificationPermissionsStatus): PermissionState {
  if (status.granted) return 'granted';
  return status.canAskAgain === false || status.status === 'denied' ? 'denied' : 'undetermined';
}

async function ensureChannel(): Promise<void> {
  if (Platform.OS !== 'android') return;
  await Notifications.setNotificationChannelAsync(CHANNEL_ID, {
    name: 'Use By reminders',
    description: 'A reminder the day before, on the day, and (if you choose) the day after an item’s Use By date.',
    importance: Notifications.AndroidImportance.DEFAULT,
  });
}

/** The fire time we scheduled, read back from the OS's description of the trigger. */
function fireAtOf(request: Notifications.NotificationRequest): number | null {
  const data = request.content.data as { fireAt?: unknown } | undefined;
  if (typeof data?.fireAt === 'number') return data.fireAt;
  const trigger = request.trigger as { value?: unknown; date?: unknown } | null;
  if (typeof trigger?.value === 'number') return trigger.value;
  if (typeof trigger?.date === 'number') return trigger.date;
  return null;
}

const platform: ReminderPlatform = {
  async getPermission() {
    return permissionState(await Notifications.getPermissionsAsync());
  },

  async listScheduled(): Promise<ScheduledReminder[]> {
    const requests = await Notifications.getAllScheduledNotificationsAsync();
    return requests.map((r) => ({
      id: r.identifier,
      fireAt: fireAtOf(r),
      body: r.content.body ?? null,
    }));
  },

  async schedule(reminder: PlannedReminder) {
    await Notifications.scheduleNotificationAsync({
      identifier: reminder.id,
      content: {
        title: reminder.title,
        body: reminder.body,
        data: { itemId: reminder.itemId, kind: reminder.kind, fireAt: reminder.fireAt },
      },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.DATE,
        date: reminder.fireAt,
        channelId: CHANNEL_ID,
      },
    });
  },

  async cancel(id) {
    await Notifications.cancelScheduledNotificationAsync(id);
  },
};

export const reminderScheduler = createReminderScheduler({
  platform,
  loadItems: getDerivedItems,
  loadPrefs: loadNotificationPrefs,
  log: (line) => console.log(`useby.reminders ${JSON.stringify(line)}`),
});

let started = false;

/**
 * Once, at app start: how a reminder looks if it fires while the app is open,
 * and the Android channel. Does not ask for permission.
 */
export async function startReminders(): Promise<void> {
  if (started) return;
  started = true;
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: false,
      shouldSetBadge: false,
    }),
  });
  try {
    await ensureChannel();
  } catch {
    // Scheduling still works on the default channel.
  }
}

export async function getReminderPermission(): Promise<PermissionState> {
  return platform.getPermission();
}

/**
 * Ask the OS, in response to the user turning reminders on. Never called on
 * launch. On Android 13+ this is the POST_NOTIFICATIONS prompt; once the user
 * has refused it twice the OS stops asking and only Settings can change it.
 */
export async function requestReminderPermission(): Promise<PermissionState> {
  await ensureChannel().catch(() => {});
  const current = await Notifications.getPermissionsAsync();
  if (current.granted || current.canAskAgain === false) return permissionState(current);
  return permissionState(await Notifications.requestPermissionsAsync());
}

export function openSystemNotificationSettings(): void {
  void Linking.openSettings().catch(() => {});
}
