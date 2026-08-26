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
import { emptyPrefill } from '../domain/scan/mapping';
import { newScanId, scanTrace } from '../domain/scan/diagnostics';
import { scanQueue } from '../domain/scan/queue';
import { usePendingCounts } from '../domain/scan/usePendingScans';
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
 * **This screen no longer waits for that call.** It used to: shutter, resize,
 * await the proxy behind a full-screen "Reading the label…", then hand the
 * result on as a navigation parameter. Production timing settled why that had
 * to go — ~1.85s of server time per scan, ~88% of it the model — and no
 * plausible tuning of the rest changes how it feels to photograph eight items
 * one after another. So the shutter now hands the photo to `scanQueue` and
 * returns to ready immediately. Results land on Home as drafts.
 *
 * The screen therefore owns no request. That is the point: it can be unmounted,
 * navigated away from, or left entirely while scans are still in flight, and
 * nothing is cancelled and nothing is lost.
 *
 * What it does *not* do is navigate away when a scan finishes. Whoever is
 * holding the phone is halfway through a bag of shopping; the app deciding they
 * are finished, because a network call happened to return, would be exactly the
 * interruption this work exists to remove.
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
   * Only the local half of a capture blocks the shutter now — the photo and the
   * resize, which are fast and genuinely cannot overlap on one camera. The wait
   * on the proxy used to be a third phase here and is gone entirely.
   */
  const [phase, setPhase] = useState<'idle' | 'capturing'>('idle');
  const [error, setError] = useState<string | null>(null);
  const busy = phase !== 'idle';

  const { counts, line } = usePendingCounts();
  const anyPending = counts.checking + counts.toReview > 0;

  async function handleCapture() {
    if (busy || !cameraRef.current) return;
    setError(null);
    setPhase('capturing');

    // The scan is named here, at the shutter, not at the request. A capture that
    // dies before anything is sent still has an id and still writes a line, so
    // "nothing happened at all" is a diagnosis rather than a gap.
    const scanId = newScanId();

    // The wait the person actually experiences starts here, not when the
    // request goes out. Capture and resize happen before the network is
    // involved and on a slow phone they are not free, so they are timed
    // separately rather than disappearing into "it took eight seconds".
    const shutterAt = Date.now();

    let imageBase64: string;
    let captureMs = 0;
    let resizeMs = 0;
    let stage: 'camera' | 'resize' | 'encode' = 'camera';
    try {
      const photo = await cameraRef.current.takePictureAsync({ quality: 0.8 });
      if (!photo) throw new Error('No photo captured.');
      captureMs = Date.now() - shutterAt;
      stage = 'resize';

      const resizeStartedAt = Date.now();

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
      resizeMs = Date.now() - resizeStartedAt;

      // What the model is actually being given. Both pairs of dimensions are
      // here because the interesting failure is the difference between them:
      // the resize constrains the *width*, so a landscape shot arrives at
      // 1200x900 where the proxy would have accepted 1568 on the long edge.
      // If real packaging reads badly, this line says whether resolution is a
      // plausible cause before anything gets changed on a hunch.
      scanTrace(scanId, 'capture', {
        outcome: 'ok',
        captureMs,
        resizeMs,
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
        totalMs: Date.now() - shutterAt,
        captureMs,
        err: e instanceof Error ? e.message.slice(0, 200) : typeof e,
      });
      setError("Couldn't use that photo — try again, or type it in.");
      setPhase('idle');
      return;
    }

    // Hand it over and let go. Nothing below this line awaits the model, and
    // nothing about this scan is owned by this component any more.
    scanQueue.add({
      scanId,
      imageBase64,
      capture: { shutterAt, captureMs, resizeMs },
    });

    setPhase('idle');
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

  return (
    <SafeAreaView style={styles.shell}>
      <View style={styles.topRow}>
        {/*
          "Done" once anything is outstanding, because by then leaving is not
          abandoning a capture — it is finishing unpacking and going to look at
          what came back. "Cancel" would misdescribe it.
        */}
        <TouchableOpacity
          onPress={() => navigation.goBack()}
          disabled={busy}
          style={styles.cancelBtn}
          accessibilityRole="button"
        >
          <Text style={styles.cancelText}>{anyPending ? 'Done' : 'Cancel'}</Text>
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

      {/*
        Guidance, not a rule. "if you can" is doing real work here: a close-up
        of just the date panel is a perfectly good capture, and the earlier
        imperative wording implied it was not. Deliberately not "expiry date" —
        under D1 that is precisely the word the packaging may not have used, and
        the app is careful everywhere else not to call an unlabelled date an
        expiry. No crop box, for the same reason.
      */}
      <Text style={styles.hint}>
        Keep the item name and printed date visible if you can
      </Text>

      {/*
        Directly under the guidance and above the shutter, because this is the
        acknowledgement that a photo was taken: press the button and the number
        under your thumb goes up. In the corner it was true but easy to miss,
        and "did that work?" is the question a camera that no longer pauses has
        to answer without being asked.

        Counts and nothing else. No percentage, no stage sequence, no estimate —
        the model's timing is unknowable from here, and inventing a number to
        fill the silence is exactly what the design forbids.
      */}
      {line && (
        <Text style={styles.pendingLine} accessibilityLiveRegion="polite">
          {line}
        </Text>
      )}

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
  /* Dimmer than the guidance above it: informative, never the thing competing
     with the shutter for attention. */
  pendingLine: {
    paddingHorizontal: 30,
    paddingTop: 2,
    textAlign: 'center',
    fontSize: 13.5,
    fontFamily: fonts.regular,
    color: colours.cameraDim,
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
});
