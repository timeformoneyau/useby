import React, { useCallback, useRef, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect, useNavigation, useRoute, RouteProp } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RootStackParamList } from '../types';
import { getDerivedItem, updateItem } from '../domain/items/service';
import { parseDate, getDaysUntilDue } from '../utils/dateUtils';
import { dateWord, heroText, longDate } from '../domain/items/presentation';
import DatePickerModal from '../components/DatePickerModal';
import { colours, fonts, hit, radius } from '../theme';

type Nav = NativeStackNavigationProp<RootStackParamList, 'EditItem'>;
type EditRoute = RouteProp<RootStackParamList, 'EditItem'>;

/**
 * Fixing a saved item: its name and its Use By date.
 *
 * The recovery path. Until now a mistake that reached storage was only
 * removable, not correctable — and that is the reason this had to exist before
 * anything could ever be accepted without review: a silently accepted error
 * with no way back is not a trade worth making.
 *
 * **Two fields, and no third.** Name and date. What the packaging called the
 * date is not offered, because the product presents one date concept and asking
 * someone to classify their own groceries against a distinction the interface
 * never otherwise makes would be asking them to do the system's filing. The
 * recorded classification survives the edit untouched; it is simply not theirs
 * to set.
 *
 * **A separate screen from Review & Save, deliberately.** That editor looks
 * similar and the temptation to add an "edit mode" to it is obvious — but its
 * save path now retains the scan photo, retires the pending draft and writes the
 * shadow-mode outcome line, and every scan in the app goes through it. Putting
 * an `if (editing)` at the top of that function to skip all three would risk the
 * one flow currently under device validation, to save a text input and a date
 * button. If editing ever grows past two fields, merging them is a deliberate
 * piece of work rather than a shortcut taken here.
 *
 * Screen state is entirely separate from stored state until Save. Cancel is
 * therefore free: nothing has been written, so there is nothing to undo.
 */
export default function EditItemScreen() {
  const navigation = useNavigation<Nav>();
  const route = useRoute<EditRoute>();
  const insets = useSafeAreaInsets();
  const { itemId } = route.params;

  const [loading, setLoading] = useState(true);
  const [missing, setMissing] = useState(false);

  /** The stored values, kept to tell an actual change from an untouched field. */
  const [original, setOriginal] = useState<{ name: string; expiryDate: string } | null>(null);

  const [name, setName] = useState('');
  const [expiryDate, setExpiryDate] = useState('');
  const [nameFocused, setNameFocused] = useState(false);
  const [showPicker, setShowPicker] = useState(false);

  /**
   * Loaded once, not on every focus.
   *
   * The date picker is a modal within this screen rather than a navigation, so
   * focus does not change while someone is editing — but reloading would
   * discard their unsaved typing if that ever stopped being true, and the fetch
   * is guarded rather than left to luck.
   */
  const loadedRef = useRef(false);

  useFocusEffect(
    useCallback(() => {
      if (loadedRef.current) return;
      loadedRef.current = true;

      let active = true;
      getDerivedItem(itemId).then((found) => {
        if (!active) return;
        if (found) {
          setOriginal({ name: found.name, expiryDate: found.expiryDate });
          setName(found.name);
          setExpiryDate(found.expiryDate);
        } else {
          setMissing(true);
        }
        setLoading(false);
      });
      return () => {
        active = false;
      };
    }, [itemId]),
  );

  /** Same guard as everywhere else: the write is an await away from the tap. */
  const savingRef = useRef(false);

  async function handleSave() {
    const trimmed = name.trim();
    if (!trimmed || savingRef.current || !original) return;
    savingRef.current = true;

    try {
      // Only what actually moved is sent. An untouched field is not part of the
      // edit at all, which is what keeps a rename from being recorded as the
      // user having set the date.
      await updateItem(itemId, {
        ...(trimmed !== original.name ? { name: trimmed } : {}),
        ...(expiryDate !== original.expiryDate ? { expiryDate } : {}),
      });
      navigation.goBack();
    } catch {
      // Let them try again rather than stranding a filled-in form behind a
      // dead button. Nothing was written, so nothing is half-done.
      savingRef.current = false;
    }
  }

  if (loading) {
    return (
      <SafeAreaView style={styles.gate}>
        <ActivityIndicator color={colours.sage} />
      </SafeAreaView>
    );
  }

  // Removed from another screen while this one sat in the stack.
  if (missing || !original) {
    return (
      <SafeAreaView style={styles.gate}>
        <View style={styles.goneBody}>
          <Text style={styles.goneTitle}>That item is gone</Text>
          <Text style={styles.goneText}>It has already been used or deleted.</Text>
          <TouchableOpacity style={styles.saveBtn} onPress={() => navigation.goBack()}>
            <Text style={styles.saveBtnText}>Back to list</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  const parsed = parseDate(expiryDate);
  const daysUntilDue = getDaysUntilDue(parsed);
  const canSave = name.trim().length > 0;

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'left', 'right']}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <View style={styles.topRow}>
          {/* Cancel, not Back. Nothing has been written, so leaving is free —
              and the word says that plainly rather than leaving someone to
              wonder whether their typing was kept. */}
          <TouchableOpacity style={styles.topBtn} onPress={() => navigation.goBack()}>
            <Text style={styles.cancelText}>Cancel</Text>
          </TouchableOpacity>
        </View>

        <ScrollView
          contentContainerStyle={[styles.content, { paddingBottom: 128 + insets.bottom }]}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.titleBlock}>
            <Text style={styles.title}>Edit item</Text>
            <Text style={styles.note}>Change the name or the date, then save.</Text>
          </View>

          <View style={styles.field}>
            <Text style={styles.fieldLabel}>Item</Text>
            <TextInput
              style={[styles.input, nameFocused && styles.inputFocused]}
              placeholder="e.g. Milk"
              placeholderTextColor={colours.placeholder}
              value={name}
              onChangeText={setName}
              onFocus={() => setNameFocused(true)}
              onBlur={() => setNameFocused(false)}
              autoCapitalize="sentences"
              returnKeyType="done"
            />
          </View>

          <View style={styles.field}>
            <Text style={styles.fieldLabel}>Use By date</Text>
            <TouchableOpacity
              style={[styles.input, styles.dateInput]}
              onPress={() => setShowPicker(true)}
              accessibilityRole="button"
              accessibilityLabel={`Use By date, ${longDate(parsed)}`}
            >
              <Text style={styles.dateValue}>{longDate(parsed)}</Text>
            </TouchableOpacity>
            <Text style={styles.previewText}>
              {`${dateWord(daysUntilDue < 0)} · ${heroText(daysUntilDue).toLowerCase()}`}
            </Text>
          </View>
        </ScrollView>

        <View style={[styles.saveBar, { paddingBottom: insets.bottom + 22 }]}>
          <TouchableOpacity
            style={[styles.saveBtn, !canSave && styles.saveBtnDisabled]}
            onPress={handleSave}
            disabled={!canSave}
            accessibilityRole="button"
            accessibilityLabel="Save changes"
          >
            <Text style={styles.saveBtnText}>Save changes</Text>
          </TouchableOpacity>
        </View>

        {showPicker && (
          <DatePickerModal
            value={expiryDate}
            onConfirm={(d) => {
              setExpiryDate(d);
              setShowPicker(false);
            }}
            onCancel={() => setShowPicker(false)}
          />
        )}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colours.background },
  flex: { flex: 1 },
  gate: {
    flex: 1,
    backgroundColor: colours.background,
    justifyContent: 'center',
    alignItems: 'center',
  },

  goneBody: { paddingHorizontal: 28, gap: 10, width: '100%' },
  goneTitle: {
    fontFamily: fonts.serif,
    fontSize: 28,
    lineHeight: 32,
    color: colours.ink,
  },
  goneText: {
    fontSize: 15.5,
    fontFamily: fonts.regular,
    lineHeight: 24,
    color: colours.textSecondary,
    marginBottom: 14,
  },

  topRow: { paddingHorizontal: 14, paddingVertical: 8 },
  topBtn: { paddingVertical: 12, paddingHorizontal: 10, alignSelf: 'flex-start' },
  cancelText: {
    fontSize: 15,
    fontFamily: fonts.regular,
    color: colours.secondaryAction,
  },

  content: { paddingHorizontal: 24, paddingTop: 4, gap: 22 },
  titleBlock: { gap: 6 },
  title: {
    fontFamily: fonts.serif,
    fontSize: 30,
    lineHeight: 34,
    color: colours.ink,
  },
  note: {
    fontSize: 15,
    fontFamily: fonts.regular,
    lineHeight: 22,
    color: colours.textSecondary,
  },

  field: { gap: 8 },
  fieldLabel: {
    fontSize: 12.5,
    fontFamily: fonts.semibold,
    letterSpacing: 0.38,
    color: colours.label,
    textTransform: 'uppercase',
  },
  input: {
    minHeight: 54,
    borderRadius: radius.chip,
    borderWidth: 1.5,
    borderColor: colours.inputBorder,
    backgroundColor: colours.card,
    paddingHorizontal: 15,
    fontSize: 16.5,
    fontFamily: fonts.regular,
    color: colours.ink,
  },
  inputFocused: { borderColor: colours.sage },
  dateInput: { justifyContent: 'center' },
  dateValue: { fontSize: 16.5, fontFamily: fonts.regular, color: colours.ink },
  previewText: { fontSize: 13.5, fontFamily: fonts.regular, color: colours.textSecondary },

  saveBar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: 24,
    paddingTop: 14,
    backgroundColor: colours.background,
    borderTopWidth: 1,
    borderTopColor: colours.divider,
  },
  saveBtn: {
    minHeight: hit.primaryButton,
    borderRadius: radius.button,
    backgroundColor: colours.sage,
    alignItems: 'center',
    justifyContent: 'center',
  },
  saveBtnDisabled: { opacity: 0.45 },
  saveBtnText: {
    fontSize: 17,
    fontFamily: fonts.semibold,
    color: colours.onSage,
  },
});
