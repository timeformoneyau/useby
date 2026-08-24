import React, { useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  Platform,
  KeyboardAvoidingView,
} from 'react-native';
import { useNavigation, useRoute, RouteProp } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RootStackParamList, ItemSource, DateType } from '../types';
import { createItem } from '../domain/items/service';
import { todayString, formatDisplay, parseDate } from '../utils/dateUtils';
import { colours } from '../components/colours';
import DatePickerModal from '../components/DatePickerModal';

type Nav = NativeStackNavigationProp<RootStackParamList, 'Add'>;
type AddRoute = RouteProp<RootStackParamList, 'Add'>;

/**
 * Review & Save — the one editor behind every way an item gets created.
 *
 * Ported from since-fresh's AddItemScreen, which served two modes (a repeat
 * interval for recurring life admin, an expiry date for scanned food). Only the
 * expiry branch survives. Also dropped on the way in: the category picker and
 * the "suggested repeat interval" banner.
 *
 * It now serves all three entry points the accepted design calls for — scan
 * review, manual entry, and (later) editing an existing item — off one prefill
 * contract, so validation, date semantics and correction behaviour cannot drift
 * apart between them. Arriving from a capture just means the fields start
 * populated and some of them may be flagged for a look.
 *
 * The AI prefills; the user decides. Nothing here treats an extraction as
 * authoritative, and an incomplete one is a normal state rather than an error
 * to recover from.
 */

const DATE_TYPE_OPTIONS: { value: DateType; label: string }[] = [
  { value: 'use_by', label: 'Use By' },
  { value: 'best_before', label: 'Best Before' },
  { value: 'unknown', label: 'Not sure' },
];

export default function AddItemScreen() {
  const navigation = useNavigation<Nav>();
  const route = useRoute<AddRoute>();
  const prefill = route.params?.prefill;
  const nameRef = useRef<TextInput>(null);

  const [name, setName] = useState(prefill?.name ?? '');
  const [expiryDate, setExpiryDate] = useState(prefill?.expiryDate ?? todayString());
  const [dateType, setDateType] = useState<DateType>(prefill?.dateType ?? 'unknown');
  const [source] = useState<ItemSource>(prefill?.source ?? 'manual');
  const [showExpiryPicker, setShowExpiryPicker] = useState(false);

  /**
   * Attention flags, not error states. They start from what the read returned
   * and clear as soon as the user touches the field — once they have looked at
   * it, it has been checked, whatever the model thought of it.
   */
  const [checkName, setCheckName] = useState(prefill?.needsNameCheck ?? false);
  const [checkDate, setCheckDate] = useState(prefill?.needsDateCheck ?? false);

  /**
   * A scan that read no date at all leaves the picker on today's date, which is
   * a real value the user could save without noticing. Worth saying so.
   */
  const dateWasRead = prefill?.expiryDate != null;
  const dateMissingFromScan = source === 'photo' && !dateWasRead;

  useEffect(() => {
    // Don't steal focus when a scan has already filled the name in — the date
    // is the more likely thing to need attention at that point.
    if (prefill?.name) return;
    const timer = setTimeout(() => nameRef.current?.focus(), 100);
    return () => clearTimeout(timer);
  }, [prefill?.name]);

  async function handleSave() {
    const trimmed = name.trim();
    if (!trimmed) return;

    // ---- Phase 3 boundary ------------------------------------------------
    // `dateType` is reviewed and corrected above but is deliberately not
    // persisted: `UseByItem` has no such field and the storage schema for it is
    // Phase 3 work (D2), with the date-aware wording that consumes it in Phase
    // 4. Widening the local schema here would mean designing it twice. What is
    // lost today is the distinction on an already-saved item; what is kept is
    // the date, which is what drives urgency.
    // ----------------------------------------------------------------------
    await createItem({ name: trimmed, expiryDate, source });
    navigation.goBack();
  }

  const canSave = name.trim().length > 0;

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: colours.background }}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <ScrollView
        style={styles.container}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        {/* Why this screen looks the way it does — a failed or partial scan
            explains itself here rather than in an alert that has to be
            dismissed before the form is usable. */}
        {prefill?.notice && (
          <View style={styles.noticeBanner}>
            <Text style={styles.noticeText}>{prefill.notice}</Text>
          </View>
        )}

        {/* Name */}
        <View style={styles.field}>
          <TextInput
            ref={nameRef}
            style={[styles.nameInput, checkName && styles.inputNeedsCheck]}
            placeholder="What is it?"
            placeholderTextColor={colours.textMuted}
            value={name}
            onChangeText={(text) => {
              setName(text);
              setCheckName(false);
            }}
            autoCapitalize="sentences"
            returnKeyType="done"
          />
          {checkName && (
            <Text style={styles.checkHint}>
              {name ? 'Worth checking — the label was hard to read.' : 'Add the item name to save.'}
            </Text>
          )}
        </View>

        {/* What the package called the date. Captured at scan time because this
            is the only moment it is cheaply available. */}
        <View style={styles.fieldGroup}>
          <Text style={styles.label}>The package says</Text>
          <View style={styles.segmentRow}>
            {DATE_TYPE_OPTIONS.map((option) => {
              const selected = dateType === option.value;
              return (
                <TouchableOpacity
                  key={option.value}
                  style={[styles.segment, selected && styles.segmentSelected]}
                  onPress={() => setDateType(option.value)}
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  accessibilityLabel={option.label}
                >
                  <Text style={[styles.segmentText, selected && styles.segmentTextSelected]}>
                    {option.label}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
          {dateType === 'unknown' && (
            <Text style={styles.helpHint}>
              We'll just call it a date — no more than the pack told us.
            </Text>
          )}
        </View>

        {/* Use by */}
        <View style={styles.fieldGroup}>
          <Text style={styles.label}>Date on the pack</Text>
          <TouchableOpacity
            style={[styles.rowButton, checkDate && styles.inputNeedsCheck]}
            onPress={() => {
              setShowExpiryPicker(true);
              setCheckDate(false);
            }}
          >
            <Text style={styles.rowButtonText}>
              {formatDisplay(parseDate(expiryDate))}
            </Text>
          </TouchableOpacity>
          {checkDate && (
            <Text style={styles.checkHint}>
              {dateMissingFromScan
                ? "We couldn't read the date — set it before saving."
                : 'Worth checking — the print was hard to read.'}
            </Text>
          )}
        </View>

        {/* Save */}
        <TouchableOpacity
          style={[styles.saveBtn, !canSave && styles.saveBtnDisabled]}
          onPress={handleSave}
          disabled={!canSave}
        >
          <Text style={styles.saveBtnText}>Track this</Text>
        </TouchableOpacity>
      </ScrollView>

      {showExpiryPicker && (
        <DatePickerModal
          value={expiryDate}
          onConfirm={(d) => { setExpiryDate(d); setShowExpiryPicker(false); }}
          onCancel={() => setShowExpiryPicker(false)}
        />
      )}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { padding: 20, paddingBottom: 60 },
  field: { marginBottom: 8 },
  nameInput: {
    fontSize: 24,
    fontWeight: '600',
    color: colours.textPrimary,
    paddingVertical: 8,
    paddingHorizontal: 0,
    borderBottomWidth: 1.5,
    borderBottomColor: colours.border,
    marginBottom: 16,
  },
  noticeBanner: {
    backgroundColor: '#F1F5F1',
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
    marginBottom: 20,
    borderWidth: 1,
    borderColor: '#D7E5D7',
  },
  noticeText: { fontSize: 13, color: colours.textSecondary, lineHeight: 18 },
  fieldGroup: { marginBottom: 20 },
  label: {
    fontSize: 11,
    fontWeight: '600',
    color: colours.textMuted,
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    marginBottom: 8,
  },
  rowButton: {
    paddingVertical: 12,
    paddingHorizontal: 14,
    backgroundColor: colours.surface,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colours.border,
  },
  rowButtonText: { fontSize: 15, color: colours.textPrimary },

  segmentRow: { flexDirection: 'row', gap: 8 },
  segment: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colours.border,
    backgroundColor: colours.surface,
    alignItems: 'center',
  },
  segmentSelected: {
    backgroundColor: colours.primary,
    borderColor: colours.primary,
  },
  segmentText: { fontSize: 14, fontWeight: '500', color: colours.textPrimary },
  segmentTextSelected: { color: '#fff', fontWeight: '600' },

  /* Attention, not alarm — the soft amber from the urgency palette rather than
     the destructive red, because nothing here has gone wrong. */
  inputNeedsCheck: { borderColor: colours.useSoon },
  checkHint: { fontSize: 13, color: colours.useSoon, marginTop: 6, lineHeight: 18 },
  helpHint: { fontSize: 13, color: colours.textSecondary, marginTop: 6, lineHeight: 18 },

  saveBtn: {
    backgroundColor: colours.textPrimary,
    paddingVertical: 15,
    borderRadius: 10,
    alignItems: 'center',
    marginTop: 12,
  },
  saveBtnDisabled: { opacity: 0.35 },
  saveBtnText: { color: '#fff', fontSize: 15, fontWeight: '600' },
});
