import React, { useRef, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as ImageManipulator from 'expo-image-manipulator';
import { useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RootStackParamList } from '../types';
import { scanPhoto } from '../domain/scan/client';
import { emptyPrefill } from '../domain/scan/mapping';
import { newScanId, scanTrace } from '../domain/scan/diagnostics';
import { colours, fonts, hit, radius } from '../theme';

type Nav = NativeStackNavigationProp<RootStackParamList, 'Capture'>;

/**
 * Camera.
 *
 * Ported from since-fresh's ScanFoodScreen. The capture, permission and resize
 * pipeline came across intact; the parse step is wired to UseBy's own deployed
 * proxy, which calls the Anthropic API and returns the item name, date and date
 * type with a per-field confidence.
 *
 * The screen never blocks on that call succeeding. Whatever comes back — a
 * clean read, a partial one, or nothing at all — the user lands in the same
 * Review & Save editor, prefilled as far as the read allowed. A failed scan is
 * a prefill with a note on it, not a dead end.
 *
 * Kept sparse deliberately: no scanner theatre, no bounding boxes, no
 * confidence readouts. The artboard also shows a "Flash auto" control, which is
 * a static label there with nothing behind it; it is left out rather than
 * shipped as a button that does nothing.
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

    // The scan is named here, at the shutter, not at the request. A capture that
    // dies before anything is sent still has an id and still writes a line, so
    // "nothing happened at all" is a diagnosis rather than a gap.
    const scanId = newScanId();

    let imageBase64: string;
    let stage: 'camera' | 'resize' | 'encode' = 'camera';
    try {
      const photo = await cameraRef.current.takePictureAsync({ quality: 0.8 });
      if (!photo) throw new Error('No photo captured.');
      stage = 'resize';

      // Resize/compress client-side. Kept from since-fresh, and now
      // load-bearing: the proxy rejects anything it cannot fit inside Vercel's
      // request-body limit, and a smaller upload is a faster scan on a phone in
      // a kitchen.
      const manipulated = await ImageManipulator.manipulateAsync(
        photo.uri,
        [{ resize: { width: 1200 } }],
        { compress: 0.7, format: ImageManipulator.SaveFormat.JPEG, base64: true },
      );

      stage = 'encode';
      if (!manipulated.base64) throw new Error('Could not process the photo.');
      imageBase64 = manipulated.base64;

      // What the model is actually being given. Both pairs of dimensions are
      // here because the interesting failure is the difference between them:
      // the resize constrains the *width*, so a landscape shot arrives at
      // 1200x900 where the proxy would have accepted 1568 on the long edge.
      // If real packaging reads badly, this line says whether resolution is a
      // plausible cause before anything gets changed on a hunch.
      scanTrace(scanId, 'capture', {
        outcome: 'ok',
        shot: { w: photo.width, h: photo.height },
        sent: { w: manipulated.width, h: manipulated.height },
        kb: Math.round(imageBase64.length / 1024),
      });
    } catch (e) {
      // Pre-request, so there is no secret anywhere near this: the message is
      // the only thing that says whether the camera, the file or the resize
      // gave up, and swallowing it left "couldn't use that photo" with nothing
      // behind it. `at` narrows it further without needing the message parsed.
      scanTrace(scanId, 'capture', {
        outcome: 'capture-failed',
        at: stage,
        err: e instanceof Error ? e.message.slice(0, 200) : typeof e,
      });
      setError("Couldn't use that photo — try again, or type it in.");
      setPhase('idle');
      return;
    }

    setPhase('reading');
    const result = await scanPhoto(imageBase64, scanId);

    navigation.replace('Add', {
      prefill: result.ok ? result.prefill : emptyPrefill('photo', result.message),
    });
  }

  if (!permission) {
    return (
      <SafeAreaView style={styles.gate}>
        <ActivityIndicator color={colours.sage} />
      </SafeAreaView>
    );
  }

  if (!permission.granted) {
    return (
      <SafeAreaView style={styles.gate}>
        <View style={styles.permissionBody}>
          <Text style={styles.permissionTitle}>Camera access needed</Text>
          <Text style={styles.permissionText}>
            UseBy uses the camera to read the use-by date on food packaging.
          </Text>
          <TouchableOpacity style={styles.primaryBtn} onPress={requestPermission}>
            <Text style={styles.primaryBtnText}>Allow camera</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.secondaryBtn}
            onPress={() => navigation.goBack()}
          >
            <Text style={styles.secondaryBtnText}>Not now</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  // The wait on the model gets the whole screen: there is nothing to frame any
  // more, and a live preview underneath would invite another shot mid-request.
  if (phase === 'reading') {
    return (
      <SafeAreaView style={styles.reading}>
        <View style={styles.readingMark} />
        <Text style={styles.readingText}>Reading the label…</Text>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.shell}>
      <View style={styles.topRow}>
        <TouchableOpacity
          onPress={() => navigation.goBack()}
          disabled={busy}
          style={styles.cancelBtn}
        >
          <Text style={styles.cancelText}>Cancel</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.preview}>
        <CameraView ref={cameraRef} style={StyleSheet.absoluteFill} facing="back" />
        {/* Four corner brackets — the only framing affordance. */}
        <View style={[styles.bracket, styles.bracketTL]} />
        <View style={[styles.bracket, styles.bracketTR]} />
        <View style={[styles.bracket, styles.bracketBL]} />
        <View style={[styles.bracket, styles.bracketBR]} />
      </View>

      <Text style={styles.hint}>Include the product name and the printed date</Text>

      {error && (
        <View style={styles.errorBanner}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      )}

      <View style={styles.controls}>
        <TouchableOpacity
          style={styles.typeItIn}
          onPress={() => navigation.replace('Add', { prefill: emptyPrefill('manual') })}
          disabled={busy}
        >
          <Text style={styles.typeItInText}>Type it in</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.shutter, busy && styles.shutterDisabled]}
          onPress={handleCapture}
          disabled={busy}
          accessibilityLabel="Capture"
          accessibilityRole="button"
        >
          {phase === 'capturing' && <ActivityIndicator color={colours.sage} />}
        </TouchableOpacity>

        <View style={styles.controlsSpacer} />
      </View>
    </SafeAreaView>
  );
}

const BRACKET = 26;

const styles = StyleSheet.create({
  shell: { flex: 1, backgroundColor: colours.cameraBg },
  gate: {
    flex: 1,
    backgroundColor: colours.background,
    justifyContent: 'center',
    alignItems: 'center',
  },

  permissionBody: { paddingHorizontal: 28, gap: 12, width: '100%' },
  permissionTitle: {
    fontFamily: fonts.serif,
    fontSize: 30,
    lineHeight: 34,
    color: colours.ink,
  },
  permissionText: {
    fontSize: 15.5,
    fontFamily: fonts.regular,
    lineHeight: 24,
    color: colours.textSecondary,
    marginBottom: 16,
  },
  primaryBtn: {
    minHeight: hit.primaryButton,
    borderRadius: radius.button,
    backgroundColor: colours.sage,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryBtnText: {
    fontSize: 17,
    fontFamily: fonts.semibold,
    color: colours.onSage,
  },
  secondaryBtn: {
    minHeight: hit.minTarget,
    alignItems: 'center',
    justifyContent: 'center',
  },
  secondaryBtnText: {
    fontSize: 14.5,
    fontFamily: fonts.medium,
    color: colours.secondaryAction,
  },

  topRow: { paddingHorizontal: 14, paddingVertical: 8 },
  cancelBtn: { paddingVertical: 12, paddingHorizontal: 10, alignSelf: 'flex-start' },
  cancelText: {
    fontSize: 15,
    fontFamily: fonts.regular,
    color: colours.cameraText,
  },

  preview: {
    flex: 1,
    marginHorizontal: 14,
    marginTop: 4,
    borderRadius: 20,
    overflow: 'hidden',
    backgroundColor: colours.cameraPanel,
  },
  bracket: {
    position: 'absolute',
    width: BRACKET,
    height: BRACKET,
    borderColor: colours.cameraBracket,
  },
  bracketTL: {
    left: 22,
    top: 22,
    borderLeftWidth: 2,
    borderTopWidth: 2,
    borderTopLeftRadius: 8,
  },
  bracketTR: {
    right: 22,
    top: 22,
    borderRightWidth: 2,
    borderTopWidth: 2,
    borderTopRightRadius: 8,
  },
  bracketBL: {
    left: 22,
    bottom: 22,
    borderLeftWidth: 2,
    borderBottomWidth: 2,
    borderBottomLeftRadius: 8,
  },
  bracketBR: {
    right: 22,
    bottom: 22,
    borderRightWidth: 2,
    borderBottomWidth: 2,
    borderBottomRightRadius: 8,
  },

  hint: {
    paddingHorizontal: 30,
    paddingTop: 20,
    paddingBottom: 6,
    textAlign: 'center',
    fontSize: 15.5,
    fontFamily: fonts.regular,
    lineHeight: 22,
    color: colours.cameraText,
  },

  errorBanner: {
    marginHorizontal: 20,
    marginTop: 8,
    borderRadius: radius.chip,
    backgroundColor: colours.destructive,
    padding: 12,
  },
  errorText: {
    color: colours.onSage,
    fontSize: 13,
    fontFamily: fonts.regular,
    textAlign: 'center',
  },

  controls: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 24,
    paddingTop: 12,
    paddingBottom: 28,
  },
  typeItIn: { width: 104, paddingVertical: 12 },
  typeItInText: {
    fontSize: 14.5,
    fontFamily: fonts.regular,
    color: colours.cameraDim,
  },
  controlsSpacer: { width: 104 },
  shutter: {
    width: 78,
    height: 78,
    borderRadius: 39,
    backgroundColor: colours.onSage,
    borderWidth: 5,
    borderColor: colours.sage,
    alignItems: 'center',
    justifyContent: 'center',
  },
  shutterDisabled: { opacity: 0.6 },

  reading: {
    flex: 1,
    backgroundColor: colours.cameraBg,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 16,
  },
  readingMark: {
    width: 40,
    height: 40,
    borderRadius: 14,
    borderBottomLeftRadius: 4,
    backgroundColor: colours.sage,
  },
  readingText: {
    fontSize: 14.5,
    fontFamily: fonts.regular,
    color: colours.cameraText,
  },
});
