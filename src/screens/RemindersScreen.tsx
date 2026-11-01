import React, { useCallback, useRef, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  Switch,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RootStackParamList } from '../types';
import {
  DEFAULT_PREFS,
  WINDOW_DAYS,
  formatTime,
  stepTime,
  type NotificationPrefs,
  type ReminderKind,
} from '../domain/notifications/policy';
import { loadNotificationPrefs, saveNotificationPrefs } from '../domain/notifications/prefsStore';
import {
  getReminderPermission,
  openSystemNotificationSettings,
  reminderScheduler,
  requestReminderPermission,
} from '../domain/notifications/reminders';
import type { PermissionState, SyncResult } from '../domain/notifications/scheduler';
import { colours, fonts, hit, radius } from '../theme';

type Nav = NativeStackNavigationProp<RootStackParamList, 'Reminders'>;

const KIND_ROWS: { kind: ReminderKind; label: string; detail: string }[] = [
  { kind: 'approaching', label: 'The day before', detail: 'Its Use By date is tomorrow' },
  { kind: 'due', label: 'On the day', detail: 'Its Use By date is today' },
  { kind: 'overdue', label: 'The day after', detail: 'Its Use By date was yesterday' },
];

/**
 * Expiry reminder settings.
 *
 * A leaf off Home (the "Reminders" link in its header), the way the edit screen
 * is a leaf off Item Detail: the four primary screens are unchanged. Local
 * only — preferences live on this device, under their own storage key.
 *
 * Turning reminders on is the only thing that asks the OS for permission. If
 * the answer is no, reminders stay off and the screen says how to change it in
 * system settings; nothing nags, and nothing is scheduled that could not be
 * shown. Every change saves and re-syncs straight away, and the status line
 * reports what is actually pending with the OS, not what was intended.
 */
export default function RemindersScreen() {
  const navigation = useNavigation<Nav>();

  const [prefs, setPrefs] = useState<NotificationPrefs>(DEFAULT_PREFS);
  const [loaded, setLoaded] = useState(false);
  const [permission, setPermission] = useState<PermissionState | null>(null);
  const [status, setStatus] = useState<SyncResult | null>(null);
  const [denied, setDenied] = useState(false);

  // Saves and syncs run one after another, in the order the taps happened.
  const chain = useRef<Promise<unknown>>(Promise.resolve());

  const refresh = useCallback(async () => {
    const [p, perm] = await Promise.all([loadNotificationPrefs(), getReminderPermission()]);
    setPrefs(p);
    setPermission(perm);
    setLoaded(true);
    setStatus(await reminderScheduler.sync('settings'));
  }, []);

  // Also on return from system settings, where permission may have changed.
  useFocusEffect(
    useCallback(() => {
      void refresh();
    }, [refresh]),
  );

  function apply(next: NotificationPrefs) {
    setPrefs(next);
    chain.current = chain.current
      .then(() => saveNotificationPrefs(next))
      .then(() => reminderScheduler.sync('prefs'))
      .then(setStatus)
      .catch(() => {});
  }

  async function toggleEnabled(on: boolean) {
    if (!on) {
      setDenied(false);
      apply({ ...prefs, enabled: false });
      return;
    }
    const perm = await requestReminderPermission();
    setPermission(perm);
    if (perm !== 'granted') {
      setDenied(true);
      return;
    }
    setDenied(false);
    apply({ ...prefs, enabled: true });
  }

  const on = prefs.enabled;
  const blocked = denied || (on && permission !== null && permission !== 'granted');

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'left', 'right']}>
      <View style={styles.topRow}>
        <TouchableOpacity style={styles.topBtn} onPress={() => navigation.goBack()}>
          <Text style={styles.backText}>Back</Text>
        </TouchableOpacity>
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.titleBlock}>
          <Text style={styles.title}>Reminders</Text>
          <Text style={styles.note}>
            A notification about food reaching its Use By date, so you don’t have to open the
            app to check.
          </Text>
        </View>

        <View style={styles.card}>
          <Row
            label="Use By reminders"
            detail={on ? 'On' : 'Off'}
            value={on}
            disabled={!loaded}
            onChange={(v) => void toggleEnabled(v)}
          />
        </View>

        {blocked && (
          <View style={styles.notice}>
            <Text style={styles.noticeText}>
              Notifications are turned off for UseBy on this phone, so reminders can’t be shown.
            </Text>
            <TouchableOpacity
              onPress={openSystemNotificationSettings}
              accessibilityRole="button"
              style={styles.noticeBtn}
            >
              <Text style={styles.noticeBtnText}>Open settings</Text>
            </TouchableOpacity>
          </View>
        )}

        <View style={[styles.section, !on && styles.sectionOff]}>
          <Text style={styles.fieldLabel}>Remind me</Text>
          <View style={styles.card}>
            {KIND_ROWS.map((row, i) => (
              <Row
                key={row.kind}
                label={row.label}
                detail={row.detail}
                value={prefs[row.kind]}
                disabled={!on}
                divided={i > 0}
                onChange={(v) => apply({ ...prefs, [row.kind]: v })}
              />
            ))}
          </View>
        </View>

        <View style={[styles.section, !on && styles.sectionOff]}>
          <Text style={styles.fieldLabel}>Time</Text>
          <View style={[styles.card, styles.timeRow]}>
            <TouchableOpacity
              style={styles.stepBtn}
              onPress={() => apply({ ...prefs, ...stepTime(prefs, -1) })}
              disabled={!on}
              accessibilityRole="button"
              accessibilityLabel="Earlier"
            >
              <Text style={styles.stepText}>−</Text>
            </TouchableOpacity>
            <Text style={styles.timeValue} accessibilityLabel={`Reminder time ${formatTime(prefs.hour, prefs.minute)}`}>
              {formatTime(prefs.hour, prefs.minute)}
            </Text>
            <TouchableOpacity
              style={styles.stepBtn}
              onPress={() => apply({ ...prefs, ...stepTime(prefs, 1) })}
              disabled={!on}
              accessibilityRole="button"
              accessibilityLabel="Later"
            >
              <Text style={styles.stepText}>+</Text>
            </TouchableOpacity>
          </View>
        </View>

        <Text style={styles.status} accessibilityLiveRegion="polite">
          {statusLine(prefs, status)}
        </Text>
        <Text style={styles.fine}>
          {`Reminders are set up to ${WINDOW_DAYS} days ahead and refreshed each time you open UseBy. Your phone decides exactly when to deliver them and may hold one back a little to save battery.`}
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

/** What is actually pending with the OS, in plain words. */
function statusLine(prefs: NotificationPrefs, status: SyncResult | null): string {
  if (!prefs.enabled) return 'Reminders are off.';
  if (!status) return '';
  switch (status.state) {
    case 'no-permission':
      return 'Waiting for notification permission.';
    case 'failed':
      return 'Reminders couldn’t be set just now. They’ll be retried next time you open UseBy.';
    case 'off':
      return 'Reminders are off.';
    case 'scheduled':
      if (status.pending === 0) return 'No reminders due in the next few weeks.';
      return status.pending === 1 ? '1 reminder scheduled' : `${status.pending} reminders scheduled`;
  }
}

function Row({
  label,
  detail,
  value,
  disabled,
  divided,
  onChange,
}: {
  label: string;
  detail: string;
  value: boolean;
  disabled?: boolean;
  divided?: boolean;
  onChange: (value: boolean) => void;
}) {
  // The whole row is the control, so a tap on the words works as well as a tap
  // on the switch, and it is announced once, as a switch.
  return (
    <TouchableOpacity
      style={[styles.row, divided && styles.rowDivided]}
      onPress={() => onChange(!value)}
      disabled={disabled}
      activeOpacity={0.7}
      accessibilityRole="switch"
      accessibilityLabel={label}
      accessibilityHint={detail}
      accessibilityState={{ checked: value, disabled: Boolean(disabled) }}
    >
      <View style={styles.rowText}>
        <Text style={styles.rowLabel}>{label}</Text>
        <Text style={styles.rowDetail}>{detail}</Text>
      </View>
      <Switch
        value={value}
        onValueChange={onChange}
        disabled={disabled}
        importantForAccessibility="no-hide-descendants"
        trackColor={{ false: colours.inputBorder, true: colours.sage }}
        thumbColor={colours.card}
      />
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colours.background },
  topRow: { paddingHorizontal: 14, paddingVertical: 8 },
  topBtn: { paddingVertical: 12, paddingHorizontal: 10, alignSelf: 'flex-start' },
  backText: { fontSize: 15, fontFamily: fonts.regular, color: colours.secondaryAction },

  content: { paddingHorizontal: 24, paddingTop: 4, paddingBottom: 40, gap: 22 },
  titleBlock: { gap: 6 },
  title: { fontFamily: fonts.serif, fontSize: 30, lineHeight: 34, color: colours.ink },
  note: { fontSize: 15, fontFamily: fonts.regular, lineHeight: 22, color: colours.textSecondary },

  section: { gap: 8 },
  sectionOff: { opacity: 0.5 },
  fieldLabel: {
    fontSize: 12.5,
    fontFamily: fonts.semibold,
    letterSpacing: 0.38,
    color: colours.label,
    textTransform: 'uppercase',
  },

  card: {
    backgroundColor: colours.card,
    borderRadius: radius.chip,
    borderWidth: 1,
    borderColor: colours.cardBorder,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: hit.row,
    paddingHorizontal: 15,
    paddingVertical: 10,
    gap: 12,
  },
  rowDivided: { borderTopWidth: 1, borderTopColor: colours.divider },
  rowText: { flex: 1, gap: 2 },
  rowLabel: { fontSize: 16, fontFamily: fonts.medium, color: colours.ink },
  rowDetail: { fontSize: 13, fontFamily: fonts.regular, color: colours.textSub },

  timeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 8,
    minHeight: hit.row,
  },
  stepBtn: {
    width: 48,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepText: { fontSize: 24, fontFamily: fonts.medium, color: colours.sage },
  timeValue: { fontSize: 18, fontFamily: fonts.semibold, color: colours.ink },

  notice: {
    backgroundColor: colours.clayFieldBg,
    borderColor: colours.clayBorder,
    borderWidth: 1,
    borderRadius: radius.chip,
    padding: 14,
    gap: 10,
  },
  noticeText: { fontSize: 14.5, fontFamily: fonts.regular, lineHeight: 21, color: colours.clayText },
  noticeBtn: { alignSelf: 'flex-start', paddingVertical: 6 },
  noticeBtnText: { fontSize: 14.5, fontFamily: fonts.semibold, color: colours.clayText },

  status: { fontSize: 14.5, fontFamily: fonts.medium, color: colours.ink },
  fine: { fontSize: 13, fontFamily: fonts.regular, lineHeight: 19, color: colours.textSub },
});
