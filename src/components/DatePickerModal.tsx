/**
 * A simple date picker implemented with ScrollView pickers (day / month / year).
 * Works on Android and iOS without any native module beyond core React Native.
 *
 * Ported from since-fresh. The only behavioural change is the year range:
 * that app picked "last done" dates, so it offered the five years *behind*
 * today. Use-by dates are mostly ahead of today, so the range is shifted to
 * one year back (for things already past) and four ahead.
 */
import React, { useState } from 'react';
import {
  Modal,
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  Pressable,
} from 'react-native';
import { parseDate, formatStorage } from '../utils/dateUtils';
import { colours, fonts, hit, radius } from '../theme';

interface Props {
  value: string; // YYYY-MM-DD
  onConfirm: (dateStr: string) => void;
  onCancel: () => void;
}

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const YEARS_BACK = 1;
const YEARS_FORWARD = 4;

function daysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate();
}

const ITEM_H = 44;

function WheelPicker({
  items,
  selectedIndex,
  onSelect,
}: {
  items: string[];
  selectedIndex: number;
  onSelect: (idx: number) => void;
}) {
  return (
    <ScrollView
      style={styles.wheel}
      showsVerticalScrollIndicator={false}
      snapToInterval={ITEM_H}
      decelerationRate="fast"
      contentOffset={{ x: 0, y: selectedIndex * ITEM_H }}
      onMomentumScrollEnd={(e) => {
        const idx = Math.round(e.nativeEvent.contentOffset.y / ITEM_H);
        onSelect(Math.max(0, Math.min(idx, items.length - 1)));
      }}
    >
      {/* padding items so selected is centred */}
      <View style={{ height: ITEM_H }} />
      {items.map((label, i) => (
        <TouchableOpacity
          key={i}
          style={[styles.wheelItem, i === selectedIndex && styles.wheelItemSelected]}
          onPress={() => onSelect(i)}
        >
          <Text
            style={[
              styles.wheelItemText,
              i === selectedIndex && styles.wheelItemTextSelected,
            ]}
          >
            {label}
          </Text>
        </TouchableOpacity>
      ))}
      <View style={{ height: ITEM_H }} />
    </ScrollView>
  );
}

export default function DatePickerModal({ value, onConfirm, onCancel }: Props) {
  const initial = parseDate(value);
  const [year, setYear] = useState(initial.getFullYear());
  const [month, setMonth] = useState(initial.getMonth()); // 0-indexed
  const [day, setDay] = useState(initial.getDate()); // 1-indexed

  const currentYear = new Date().getFullYear();
  const firstYear = currentYear - YEARS_BACK;
  const years = Array.from(
    { length: YEARS_BACK + YEARS_FORWARD + 1 },
    (_, i) => String(firstYear + i),
  );
  const numDays = daysInMonth(year, month);
  const clampedDay = Math.min(day, numDays);
  const days = Array.from({ length: numDays }, (_, i) => String(i + 1).padStart(2, '0'));

  function handleConfirm() {
    const d = new Date(year, month, clampedDay);
    onConfirm(formatStorage(d));
  }

  return (
    <Modal transparent animationType="slide" onRequestClose={onCancel}>
      <Pressable style={styles.backdrop} onPress={onCancel} />
      <View style={styles.sheet}>
        <View style={styles.toolbar}>
          <TouchableOpacity onPress={onCancel}>
            <Text style={styles.toolbarCancel}>Cancel</Text>
          </TouchableOpacity>
          <Text style={styles.toolbarTitle}>Date on the pack</Text>
          <TouchableOpacity onPress={handleConfirm}>
            <Text style={styles.toolbarDone}>Done</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.pickers}>
          {/* Day */}
          <WheelPicker
            items={days}
            selectedIndex={clampedDay - 1}
            onSelect={(i) => setDay(i + 1)}
          />
          {/* Month */}
          <WheelPicker
            items={MONTHS}
            selectedIndex={month}
            onSelect={(i) => setMonth(i)}
          />
          {/* Year */}
          <WheelPicker
            items={years}
            selectedIndex={years.indexOf(String(year))}
            onSelect={(i) => setYear(firstYear + i)}
          />
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(38,29,23,0.35)',
  },
  sheet: {
    backgroundColor: colours.card,
    borderTopLeftRadius: radius.panel,
    borderTopRightRadius: radius.panel,
    borderTopWidth: 1,
    borderColor: colours.panelBorder,
    paddingBottom: 32,
  },
  toolbar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: colours.divider,
  },
  toolbarCancel: {
    fontSize: 15,
    fontFamily: fonts.regular,
    color: colours.secondaryAction,
  },
  toolbarTitle: { fontSize: 15, fontFamily: fonts.semibold, color: colours.ink },
  toolbarDone: { fontSize: 15, fontFamily: fonts.semibold, color: colours.sage },
  pickers: {
    flexDirection: 'row',
    height: ITEM_H * 5,
    paddingHorizontal: 12,
  },
  wheel: { flex: 1 },
  wheelItem: {
    height: ITEM_H,
    justifyContent: 'center',
    alignItems: 'center',
  },
  wheelItemSelected: {
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: colours.divider,
    backgroundColor: colours.background,
  },
  wheelItemText: {
    fontSize: 15,
    fontFamily: fonts.regular,
    color: colours.textSecondary,
  },
  wheelItemTextSelected: {
    color: colours.ink,
    fontFamily: fonts.semibold,
  },
});
