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
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation, useRoute, RouteProp } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RootStackParamList, ItemSource, DateType } from '../types';
import { createItem } from '../domain/items/service';
import { todayString, parseDate, getDaysUntilDue } from '../utils/dateUtils';
import { heroText, longDate, typeWord } from '../domain/items/presentation';
import { colours, fonts, hit, radius } from '../theme';
import DatePickerModal from '../components/DatePickerModal';
import { reviewCopy } from '../domain/scan/mapping';
import { scanQueue } from '../domain/scan/queue';

type Nav = NativeStackNavigationProp<RootStackParamList, 'Add'>;
type AddRoute = RouteProp<RootStackParamList, 'Add'>;

/**
 * Review & Save — the one editor behind every way an item gets created.
 *
 * Ported from since-fresh's AddItemScreen, which served two modes (a repeat
 * interval for recurring life admin, an expiry date for scanned food). Only the
 * expiry branch survives, and the category picker and cadence-guessing banner
 * were dropped on the way in.
 *
 * It serves scan review and manual entry off one prefill contract, so
 * validation, date semantics and correction behaviour cannot drift apart
 * between them. Arriving from a capture just means the fields start populated
 * and some of them may be flagged for a look.
 *
 * The AI prefills; the user decides. Nothing here treats an extraction as
 * authoritative, and an incomplete one is a normal state rather than an error
 * to recover from.
 *
 * On the date field: the artboard uses a free-text input that parses what you
 * type. That is a prototype convenience — typing a date on a phone is more
 * friction than the wheel, and the wheel cannot produce an unparseable value.
 * The field wears the artboard's styling and opens the native picker.
 */

const DATE_TYPE_OPTIONS: { value: DateType; label: string }[] = [
  { value: 'use_by', label: 'Use By' },
  { value: 'best_before', label: 'Best Before' },
  { value: 'unknown', label: 'Not sure' },
];

export default function AddItemScreen() {
  const navigation = useNavigation<Nav>();
  const route = useRoute<AddRoute>();
  const insets = useSafeAreaInsets();
  const prefill = route.params?.prefill;
  /**
   * Set when this editor is showing a pending scan rather than a manual add.
   *
   * Its only jobs are to retire the draft once the item is saved and to offer
   * Discard. The form itself is still driven entirely by `prefill`, so nothing
   * about a manual add changes and the editor cannot be emptied underneath the
   * user by a draft disappearing from the queue mid-edit.
   */
  const scanId = route.params?.scanId;
  const nameRef = useRef<TextInput>(null);

  const [name, setName] = useState(prefill?.name ?? '');
  const [expiryDate, setExpiryDate] = useState(prefill?.expiryDate ?? todayString());
  const [dateType, setDateType] = useState<DateType>(prefill?.dateType ?? 'unknown');
  const [source] = useState<ItemSource>(prefill?.source ?? 'manual');
  const [showExpiryPicker, setShowExpiryPicker] = useState(false);
  const [nameFocused, setNameFocused] = useState(false);

  /**
   * Attention flags, not error states. They start from what the read returned
   * and clear as soon as the user touches the field — once they have looked at
   * it, it has been checked, whatever the model thought.
   */
  const [checkName, setCheckName] = useState(prefill?.needsNameCheck ?? false);
  const [checkDate, setCheckDate] = useState(prefill?.needsDateCheck ?? false);

  const dateWasRead = prefill?.expiryDate != null;
  const dateMissingFromScan = source === 'photo' && !dateWasRead;
  const cameFromPhoto = source === 'photo';

  const { title, note } = reviewCopy(
    source,
    Boolean(prefill?.notice),
    Boolean(prefill?.name),
    dateWasRead,
  );

  useEffect(() => {
    if (prefill?.name) return;
    const timer = setTimeout(() => nameRef.current?.focus(), 100);
    return () => clearTimeout(timer);
  }, [prefill?.name]);

  /**
   * A ref, not state: it has to take effect within the same tick as the tap.
   *
   * `createItem` is an await away from the button, and a second press landing
   * in that gap would write the item twice. Re-rendering with a disabled button
   * is too late — the guard has to be readable before React has done anything.
   * Previously theoretical; with drafts there is now a list of things to save in
   * a row, which is exactly when people double-tap.
   */
  const savingRef = useRef(false);

  /**
   * Leave the editor and go back to whatever opened it.
   *
   * Was `navigate('Main')`, which was correct while Home was the only way in.
   * The camera now opens this editor too — tap the result card that appears a
   * couple of seconds after the shutter — and from there `navigate('Main')`
   * would tear the camera off the stack and land someone on Home in the middle
   * of unpacking a bag. Going back instead returns to Home from Home and to the
   * camera from the camera, so neither caller is surprised and the scanning
   * rhythm survives a save.
   *
   * `Main` is the navigator's first screen, so there is always somewhere to go
   * back to; the fallback is belt for a stack shape that does not exist today.
   */
  function dismiss() {
    if (navigation.canGoBack()) navigation.goBack();
    else navigation.navigate('Main');
  }

  async function handleSave() {
    const trimmed = name.trim();
    if (!trimmed || savingRef.current) return;
    savingRef.current = true;

    try {
      await createItem({ name: trimmed, expiryDate, dateType, source });
      // Retire the draft only once the item is genuinely stored. Reversed, a
      // failed write would take the scan with it and leave nothing behind.
      if (scanId) scanQueue.remove(scanId);
      dismiss();
    } catch {
      // Let them try again rather than stranding a filled-in form behind a
      // permanently disabled button.
      savingRef.current = false;
    }
  }

  /**
   * Throw this scan away. The one destructive action here, and explicit.
   *
   * Deliberately not on the Home row: a small target beside a draft is a
   * mis-tap waiting to happen, and this way the scan is only ever discarded by
   * someone who has just looked at what it is. That is also why there is no
   * confirmation dialog — the screen already is the confirmation.
   */
  function handleDiscard() {
    if (scanId) scanQueue.remove(scanId);
    dismiss();
  }

  const canSave = name.trim().length > 0;
  const parsed = parseDate(expiryDate);
  const daysUntilDue = getDaysUntilDue(parsed);

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'left', 'right']}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <View style={styles.topRow}>
          {/*
            Back is non-destructive, and that is the deliberate choice: a scan
            opened, read and backed out of stays on Home exactly as it was.
            Losing a photograph because someone wanted a second look at the
            packet would be the worst possible reading of "review before save".
            Discard, below, is the way to actually get rid of one.
          */}
          <TouchableOpacity style={styles.topBtn} onPress={dismiss}>
            <Text style={styles.backText}>Back</Text>
          </TouchableOpacity>
          {/*
            Retake names the draft it is for, and that name is the whole fix for
            the duplicate. Before this it opened a bare camera, the next shutter
            minted a new id and enqueued alongside the original, and one physical
            pack became two rows — which is exactly what the device test found.
            Now the camera is told what this photo is replacing.

            The draft is still left in place here, and deliberately: discarding
            it at this tap would be reasonable right up until someone opens the
            camera, changes their mind and backs out, at which point the original
            would be gone and nothing would have replaced it. It is retired by
            the replacement, not by the intention to make one.
          */}
          {cameFromPhoto && (
            <TouchableOpacity
              style={styles.topBtn}
              onPress={() => navigation.replace('Capture', { replacing: scanId })}
            >
              <Text style={styles.retakeText}>Retake</Text>
            </TouchableOpacity>
          )}
        </View>

        <ScrollView
          contentContainerStyle={[styles.content, { paddingBottom: 128 + insets.bottom }]}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.titleBlock}>
            <Text style={styles.title}>{title}</Text>
            <Text style={styles.note}>{note}</Text>
          </View>

          {prefill?.notice && (
            <View style={styles.noticeBanner}>
              <Text style={styles.noticeText}>{prefill.notice}</Text>
            </View>
          )}

          {/* Item */}
          <View style={styles.field}>
            <Text style={styles.fieldLabel}>Item</Text>
            <TextInput
              ref={nameRef}
              style={[
                styles.input,
                nameFocused && styles.inputFocused,
                checkName && styles.inputChecking,
              ]}
              placeholder="e.g. Milk"
              placeholderTextColor={colours.placeholder}
              value={name}
              onChangeText={(text) => {
                setName(text);
                setCheckName(false);
              }}
              onFocus={() => setNameFocused(true)}
              onBlur={() => setNameFocused(false)}
              autoCapitalize="sentences"
              returnKeyType="done"
            />
            {checkName && (
              <Text style={styles.checkHint}>
                {name
                  ? 'Worth checking — the label was hard to read.'
                  : 'Add the item name to save.'}
              </Text>
            )}
          </View>

          {/* What the pack called the date */}
          <View style={styles.field}>
            <Text style={styles.fieldLabel}>The package says</Text>
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
                    <Text
                      style={[
                        styles.segmentText,
                        selected && styles.segmentTextSelected,
                      ]}
                    >
                      {option.label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
            {dateType === 'unknown' && (
              <Text style={styles.helpHint}>
                We'll just call it “Date” — no more than the pack told us.
              </Text>
            )}
          </View>

          {/* Date */}
          <View style={styles.field}>
            <Text style={styles.fieldLabel}>Date on the pack</Text>
            <TouchableOpacity
              style={[styles.input, styles.dateInput, checkDate && styles.inputChecking]}
              onPress={() => {
                setShowExpiryPicker(true);
                setCheckDate(false);
              }}
              accessibilityRole="button"
              accessibilityLabel={`Date on the pack, ${longDate(parsed)}`}
            >
              <Text style={styles.dateValue}>{longDate(parsed)}</Text>
            </TouchableOpacity>

            {checkDate ? (
              <View style={styles.warnRow}>
                <View style={styles.warnMark}>
                  <Text style={styles.warnMarkText}>!</Text>
                </View>
                <Text style={styles.warnText}>
                  {dateMissingFromScan
                    ? "We couldn't read the date — set it before saving."
                    : 'Worth checking — the print was hard to read.'}
                </Text>
              </View>
            ) : (
              <Text style={styles.previewText}>
                {`${typeWord(dateType, daysUntilDue < 0)} · ${heroText(daysUntilDue).toLowerCase()}`}
              </Text>
            )}
          </View>

          {scanId && (
            <TouchableOpacity
              style={styles.discardBtn}
              onPress={handleDiscard}
              accessibilityRole="button"
            >
              <Text style={styles.discardText}>Discard this scan</Text>
            </TouchableOpacity>
          )}
        </ScrollView>

        <View style={[styles.saveBar, { paddingBottom: insets.bottom + 22 }]}>
          <TouchableOpacity
            style={[styles.saveBtn, !canSave && styles.saveBtnDisabled]}
            onPress={handleSave}
            disabled={!canSave}
          >
            <Text style={styles.saveBtnText}>Save item</Text>
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>

      {showExpiryPicker && (
        <DatePickerModal
          value={expiryDate}
          onConfirm={(d) => {
            setExpiryDate(d);
            setShowExpiryPicker(false);
          }}
          onCancel={() => setShowExpiryPicker(false)}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colours.background },
  flex: { flex: 1 },

  topRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingTop: 4,
  },
  topBtn: { padding: 12 },
  backText: { fontSize: 15, fontFamily: fonts.regular, color: colours.secondaryAction },
  retakeText: { fontSize: 15, fontFamily: fonts.medium, color: colours.sage },

  content: { paddingHorizontal: 22, paddingTop: 4, gap: 20 },

  titleBlock: { gap: 6 },
  title: {
    fontFamily: fonts.serif,
    fontSize: 30,
    lineHeight: 33,
    letterSpacing: -0.3,
    color: colours.ink,
  },
  note: {
    fontSize: 14.5,
    fontFamily: fonts.regular,
    lineHeight: 21,
    color: colours.textSecondary,
  },

  noticeBanner: {
    backgroundColor: colours.sageTint,
    borderWidth: 1,
    borderColor: colours.sageTintBorder,
    borderRadius: radius.chip,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  noticeText: {
    fontSize: 13.5,
    fontFamily: fonts.medium,
    lineHeight: 19,
    color: colours.sagePressed,
  },

  field: { gap: 8 },
  fieldLabel: { fontSize: 13, fontFamily: fonts.semibold, color: colours.label },

  input: {
    minHeight: hit.primaryButton,
    paddingHorizontal: 15,
    paddingVertical: 12,
    fontSize: 18,
    fontFamily: fonts.medium,
    letterSpacing: -0.27,
    borderWidth: 1.5,
    borderColor: colours.inputBorder,
    borderRadius: 14,
    backgroundColor: colours.card,
    color: colours.ink,
  },
  inputFocused: { borderColor: colours.barSoon, backgroundColor: '#FFFFFF' },
  inputChecking: { borderColor: colours.clayBorder, backgroundColor: colours.clayFieldBg },
  dateInput: { justifyContent: 'center' },
  dateValue: {
    fontSize: 18,
    fontFamily: fonts.medium,
    letterSpacing: -0.18,
    color: colours.ink,
  },

  segmentRow: { flexDirection: 'row', gap: 8 },
  segment: {
    flex: 1,
    minHeight: 54,
    borderRadius: radius.segment,
    borderWidth: 1.5,
    borderColor: colours.inputBorder,
    backgroundColor: colours.card,
    alignItems: 'center',
    justifyContent: 'center',
  },
  segmentSelected: { backgroundColor: colours.sage, borderColor: colours.sage },
  segmentText: {
    fontSize: 14.5,
    fontFamily: fonts.semibold,
    letterSpacing: -0.15,
    color: colours.ink,
  },
  segmentTextSelected: { color: colours.onSage },

  checkHint: {
    fontSize: 13.5,
    fontFamily: fonts.regular,
    lineHeight: 19,
    color: colours.clayText,
  },
  helpHint: {
    fontSize: 13.5,
    fontFamily: fonts.regular,
    lineHeight: 19,
    color: colours.textSecondary,
  },
  previewText: { fontSize: 13.5, fontFamily: fonts.regular, color: colours.textSecondary },

  /* Below the fields and quiet: reachable, never the thing the eye lands on. */
  discardBtn: {
    minHeight: hit.minTarget,
    alignItems: 'center',
    justifyContent: 'center',
  },
  discardText: { fontSize: 14, fontFamily: fonts.medium, color: colours.secondaryAction },

  warnRow: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  warnMark: {
    width: 16,
    height: 16,
    borderRadius: 8,
    borderWidth: 1.5,
    borderColor: colours.clay,
    alignItems: 'center',
    justifyContent: 'center',
  },
  warnMarkText: { fontSize: 10, fontFamily: fonts.bold, color: colours.clay },
  warnText: {
    flex: 1,
    fontSize: 13.5,
    fontFamily: fonts.regular,
    lineHeight: 19,
    color: colours.clayText,
  },

  saveBar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingTop: 16,
    paddingHorizontal: 22,
    backgroundColor: colours.background,
    borderTopWidth: 1,
    borderTopColor: colours.panelBorder,
  },
  saveBtn: {
    minHeight: hit.primaryButton,
    borderRadius: radius.button,
    backgroundColor: colours.sage,
    alignItems: 'center',
    justifyContent: 'center',
  },
  saveBtnDisabled: { opacity: 0.35 },
  saveBtnText: {
    fontSize: 17,
    fontFamily: fonts.semibold,
    color: colours.onSage,
  },
});
