/**
 * Reminder preferences on the device.
 *
 * Their own AsyncStorage key, entirely separate from the items envelope: the
 * item persistence model is not touched, and a corrupt or missing preferences
 * record can only ever fall back to the defaults (reminders off).
 *
 * Local only. No account, no sync.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { parsePrefs, type NotificationPrefs } from './policy';

const PREFS_KEY = '@useby_v1_notification_prefs';

export async function loadNotificationPrefs(): Promise<NotificationPrefs> {
  try {
    return parsePrefs(await AsyncStorage.getItem(PREFS_KEY));
  } catch {
    return parsePrefs(null);
  }
}

export async function saveNotificationPrefs(prefs: NotificationPrefs): Promise<void> {
  await AsyncStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
}
