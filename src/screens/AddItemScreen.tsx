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
import { RootStackParamList, ItemSource } from '../types';
import { createItem } from '../domain/items/service';
import { todayString, formatDisplay, parseDate } from '../utils/dateUtils';
import { colours } from '../components/colours';
import DatePickerModal from '../components/DatePickerModal';

type Nav = NativeStackNavigationProp<RootStackParamList, 'Add'>;
type AddRoute = RouteProp<RootStackParamList, 'Add'>;

/**
 * The single "+" Add flow.
 *
 * Ported from since-fresh's AddItemScreen, which was one screen serving two
 * modes: a repeat interval (value + days/weeks/months/years unit picker) for
 * recurring life admin, and an expiry date for scanned food, with the expiry
 * branch hiding the repeat controls. Only the expiry branch survives here, so
 * the form is name + use-by date. Also dropped: the category picker, and the
 * "suggested repeat interval" banner that guessed a cadence from names like
 * "dentist".
 *
 * Reaching this screen from a capture keeps the same prefill contract, so
 * both entry points land in one place.
 */
export default function AddItemScreen() {
  const navigation = useNavigation<Nav>();
  const route = useRoute<AddRoute>();
  const prefill = route.params?.prefill;
  const nameRef = useRef<TextInput>(null);

  const [name, setName] = useState(prefill?.name ?? '');
  const [expiryDate, setExpiryDate] = useState(prefill?.expiryDate ?? todayString());
  const [source] = useState<ItemSource>(prefill?.source ?? 'manual');
  const [showExpiryPicker, setShowExpiryPicker] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => nameRef.current?.focus(), 100);
    return () => clearTimeout(timer);
  }, []);

  async function handleSave() {
    const trimmed = name.trim();
    if (!trimmed) return;

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
        {/* Name */}
        <View style={styles.field}>
          <TextInput
            ref={nameRef}
            style={styles.nameInput}
            placeholder="What is it?"
            placeholderTextColor={colours.textMuted}
            value={name}
            onChangeText={setName}
            autoCapitalize="sentences"
            returnKeyType="done"
          />
        </View>

        {/* Capture banner */}
        {source === 'photo' && (
          <View style={styles.captureBanner}>
            <Text style={styles.captureBannerText}>
              Added from a photo — type the name and use-by date you can see on the packaging.
            </Text>
          </View>
        )}

        {/* Use by */}
        <View style={styles.fieldGroup}>
          <Text style={styles.label}>Use by</Text>
          <TouchableOpacity
            style={styles.rowButton}
            onPress={() => setShowExpiryPicker(true)}
          >
            <Text style={styles.rowButtonText}>
              {formatDisplay(parseDate(expiryDate))}
            </Text>
          </TouchableOpacity>
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
  captureBanner: {
    backgroundColor: '#F1F5F1',
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
    marginBottom: 20,
    borderWidth: 1,
    borderColor: '#D7E5D7',
  },
  captureBannerText: { fontSize: 13, color: colours.textSecondary, lineHeight: 18 },
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
