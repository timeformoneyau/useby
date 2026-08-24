import React, { useRef, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  SafeAreaView,
} from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as ImageManipulator from 'expo-image-manipulator';
import { useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RootStackParamList } from '../types';
import { colours } from '../components/colours';
import { scanPhoto } from '../domain/scan/client';
import { emptyPrefill } from '../domain/scan/mapping';

type Nav = NativeStackNavigationProp<RootStackParamList, 'Capture'>;

/**
 * Camera capture.
 *
 * Ported from since-fresh's ScanFoodScreen. The capture, permission and resize
 * pipeline came across intact; the parse step that was stubbed out at scaffold
 * time is now wired to UseBy's own deployed proxy, which calls the Anthropic
 * API and returns the item name, date and date type with a per-field
 * confidence.
 *
 * The screen never blocks on that call succeeding. Whatever comes back — a
 * clean read, a partial one, or nothing at all — the user lands in the same
 * Review & Save editor, prefilled as far as the read allowed. A failed scan is
 * a prefill with a note on it, not a dead end.
 */
export default function CaptureScreen() {
  const navigation = useNavigation<Nav>();
  const [permission, requestPermission] = useCameraPermissions();
  const cameraRef = useRef<CameraView>(null);
  /**
   * 'capturing' covers the shutter and the resize; 'reading' covers the wait on
   * the proxy. They are separate because the second one is the slow half and
   * deserves to say what it is doing.
   */
  const [phase, setPhase] = useState<'idle' | 'capturing' | 'reading'>('idle');
  const [error, setError] = useState<string | null>(null);
  const busy = phase !== 'idle';

  async function handleCapture() {
    if (busy || !cameraRef.current) return;
    setError(null);
    setPhase('capturing');

    let imageBase64: string;
    try {
      const photo = await cameraRef.current.takePictureAsync({ quality: 0.8 });
      if (!photo) throw new Error('No photo captured.');

      // Resize/compress client-side. Kept from since-fresh, and now load-bearing:
      // the proxy rejects anything over ~4.4MB decoded, and a smaller upload is
      // a faster scan on a phone in a kitchen.
      const manipulated = await ImageManipulator.manipulateAsync(
        photo.uri,
        [{ resize: { width: 1200 } }],
        { compress: 0.7, format: ImageManipulator.SaveFormat.JPEG, base64: true },
      );

      if (!manipulated.base64) throw new Error('Could not process the photo.');
      imageBase64 = manipulated.base64;
    } catch {
      // The camera or the resize failed, so there is nothing to send. Stay put
      // and let them try another shot.
      setError("Couldn't use that photo — try again, or type it in.");
      setPhase('idle');
      return;
    }

    setPhase('reading');
    const result = await scanPhoto(imageBase64);

    // Both branches land in the same editor. A failed read simply arrives with
    // nothing filled in and a note saying why.
    navigation.replace('Add', {
      prefill: result.ok
        ? result.prefill
        : emptyPrefill('photo', result.message),
    });
  }

  if (!permission) {
    return (
      <SafeAreaView style={styles.safe}>
        <ActivityIndicator color={colours.textPrimary} />
      </SafeAreaView>
    );
  }

  if (!permission.granted) {
    return (
      <SafeAreaView style={styles.safe}>
        <View style={styles.permissionContainer}>
          <Text style={styles.permissionTitle}>Camera access needed</Text>
          <Text style={styles.permissionBody}>
            UseBy uses the camera to capture the use-by date on food packaging.
          </Text>
          <TouchableOpacity style={styles.primaryBtn} onPress={requestPermission}>
            <Text style={styles.primaryBtnText}>Allow camera</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.secondaryBtn} onPress={() => navigation.goBack()}>
            <Text style={styles.secondaryBtnText}>Cancel</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <View style={styles.cameraContainer}>
      <CameraView ref={cameraRef} style={styles.camera} facing="back" />

      <View style={styles.overlay}>
        <Text style={styles.hint}>
          Frame the use-by date and the item name, then capture
        </Text>
      </View>

      {phase === 'reading' && (
        <View style={styles.readingBanner}>
          <ActivityIndicator color="#fff" />
          <Text style={styles.readingText}>Reading the label…</Text>
        </View>
      )}

      {error && (
        <View style={styles.errorBanner}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      )}

      <View style={styles.controls}>
        <TouchableOpacity style={styles.cancelBtn} onPress={() => navigation.goBack()} disabled={busy}>
          <Text style={styles.cancelBtnText}>Cancel</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.captureBtn, busy && styles.captureBtnDisabled]}
          onPress={handleCapture}
          disabled={busy}
          accessibilityLabel="Capture"
          accessibilityRole="button"
        >
          {busy ? <ActivityIndicator color="#fff" /> : <View style={styles.captureBtnInner} />}
        </TouchableOpacity>

        <View style={styles.controlsSpacer} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colours.background, justifyContent: 'center' },
  permissionContainer: { flex: 1, padding: 32, justifyContent: 'center' },
  permissionTitle: { fontSize: 20, fontWeight: '700', color: colours.textPrimary, marginBottom: 10 },
  permissionBody: { fontSize: 15, color: colours.textSecondary, lineHeight: 22, marginBottom: 28 },
  primaryBtn: {
    backgroundColor: colours.textPrimary,
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: 'center',
    marginBottom: 12,
  },
  primaryBtnText: { color: '#fff', fontSize: 15, fontWeight: '600' },
  secondaryBtn: { paddingVertical: 12, alignItems: 'center' },
  secondaryBtnText: { color: colours.textSecondary, fontSize: 15 },

  cameraContainer: { flex: 1, backgroundColor: '#000' },
  camera: { flex: 1 },
  overlay: {
    position: 'absolute',
    top: 60,
    left: 0,
    right: 0,
    alignItems: 'center',
    paddingHorizontal: 32,
  },
  hint: {
    color: '#fff',
    fontSize: 14,
    textAlign: 'center',
    backgroundColor: 'rgba(0,0,0,0.45)',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
  },
  readingBanner: {
    position: 'absolute',
    bottom: 130,
    left: 20,
    right: 20,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    backgroundColor: 'rgba(0,0,0,0.6)',
    borderRadius: 8,
    padding: 12,
  },
  readingText: { color: '#fff', fontSize: 14 },
  errorBanner: {
    position: 'absolute',
    bottom: 130,
    left: 20,
    right: 20,
    backgroundColor: 'rgba(192,57,43,0.92)',
    borderRadius: 8,
    padding: 12,
  },
  errorText: { color: '#fff', fontSize: 13, textAlign: 'center' },
  controls: {
    position: 'absolute',
    bottom: 36,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 28,
  },
  cancelBtn: { width: 64 },
  cancelBtnText: { color: '#fff', fontSize: 15 },
  controlsSpacer: { width: 64 },
  captureBtn: {
    width: 72,
    height: 72,
    borderRadius: 36,
    borderWidth: 4,
    borderColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  captureBtnDisabled: { opacity: 0.6 },
  captureBtnInner: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: '#fff',
  },
});
