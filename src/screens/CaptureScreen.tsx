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

type Nav = NativeStackNavigationProp<RootStackParamList, 'Capture'>;

/**
 * Camera capture.
 *
 * Ported from since-fresh's ScanFoodScreen with the network half removed. The
 * original POSTed the captured frame to a Vercel proxy, which called the
 * Anthropic API to read the item name and expiry date off the packaging and
 * returned them (with per-field confidence) as the Add screen's prefill.
 *
 * That proxy and its API key are a later phase, so capture currently stops at
 * the resized JPEG and hands the user to the Add screen to type the details
 * themselves. The capture, permission and resize pipeline is intact and is
 * the part the parse step will plug into — see the marked seam in
 * handleCapture().
 */
export default function CaptureScreen() {
  const navigation = useNavigation<Nav>();
  const [permission, requestPermission] = useCameraPermissions();
  const cameraRef = useRef<CameraView>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleCapture() {
    if (busy || !cameraRef.current) return;
    setError(null);
    setBusy(true);

    try {
      const photo = await cameraRef.current.takePictureAsync({ quality: 0.8 });
      if (!photo) throw new Error('No photo captured.');

      // Resize/compress client-side. Kept from since-fresh: this is what keeps
      // the eventual upload payload small, and it is cheap enough to leave in
      // place while the parse step is still a stub.
      const manipulated = await ImageManipulator.manipulateAsync(
        photo.uri,
        [{ resize: { width: 1200 } }],
        { compress: 0.7, format: ImageManipulator.SaveFormat.JPEG, base64: true },
      );

      if (!manipulated.base64) throw new Error('Could not process the photo.');

      // ---- Parse seam -------------------------------------------------
      // Later phase: POST manipulated.base64 to the proxy, and use the
      // returned name/date (and confidence) as the prefill below instead of
      // the empty values.
      // -----------------------------------------------------------------

      navigation.replace('Add', {
        prefill: { name: '', expiryDate: null, source: 'photo' },
      });
    } catch {
      setError("Couldn't use that photo — please enter the details manually.");
      setBusy(false);
    }
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
