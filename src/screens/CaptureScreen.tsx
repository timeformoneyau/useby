import React, { useEffect, useMemo, useRef, useState } from 'react';
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
import { useNavigation, useRoute, RouteProp } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RootStackParamList } from '../types';
import { emptyPrefill, failureMessage } from '../domain/scan/mapping';
import { newScanId, scanTrace, trustTrace } from '../domain/scan/diagnostics';
import { scanQueue } from '../domain/scan/queue';
import { latestSettled, type PendingScan } from '../domain/scan/pending';
import { usePendingCounts, usePendingScans } from '../domain/scan/usePendingScans';
import { warmProxy } from '../config/proxy';
import CameraResultCard from '../components/CameraResultCard';
import { colours, fonts, hit, radius } from '../theme';

type CaptureRoute = RouteProp<RootStackParamList, 'Capture'>;

/**
 * Longest edge we send.
 *
 * The model's vision tier downsamples above 1568px, so more pixels cost upload
 * time and buy nothing. What matters is that this constrains the *long* edge:
 * the previous `width: 1200` was a third rule that quietly threw away a quarter
 * of the resolution on any landscape shot, and the date stamp is the smallest
 * thing in the frame.
 */
const MAX_EDGE_PX = 1568;

/**
 * JPEG quality for the one re-encode we cannot avoid.
 *
 * Raised from 0.7 alongside the resolution, and for the same reason: the
 * characters that matter are small, low-contrast and often embossed, and they
 * are exactly what compression eats first. The upload is larger, which no
 * longer costs anyone anything now that nothing waits on it.
 */
const JPEG_QUALITY = 0.8;

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
 * returns to ready immediately.
 *
 * **Results come back to this screen.** They used to land only on Home, and the
 * real-device test found the cost of that: by the time anyone looked, the
 * shopping was put away and three rows saying `Beef mince` matched no
 * particular pack any more. So each scan, as it settles, surfaces here as one
 * card carrying the photograph that produced it — in front of someone still
 * holding the thing it describes. It floats over the preview, it never blocks
 * the shutter, and ignoring it entirely is a supported way to use this screen.
 * Every draft is still on Home either way; nothing here saves anything.
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
  const route = useRoute<CaptureRoute>();
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

  const scans = usePendingScans();

  /**
   * Results the user has waved off this visit to the camera.
   *
   * View state, not queue state — the draft is untouched and still on Home, so
   * dismissing costs nothing and needs no confirmation. Kept here rather than
   * in the queue because it is about what this screen is showing, not about
   * what the scan is.
   */
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set());

  /**
   * When this visit to the camera began.
   *
   * The card shows results that arrive while someone is standing here, not the
   * backlog. Without this, opening the camera to photograph the next thing
   * would greet you with the answer to something from five minutes ago — stale,
   * and an interruption rather than news. Anything older is still on Home.
   */
  const openedAt = useRef(Date.now()).current;
  const showing = useMemo(
    () => latestSettled(scans, dismissed, openedAt),
    [scans, dismissed, openedAt],
  );

  /**
   * The draft this visit is retaking, if any. Consumed by the first shutter.
   *
   * A ref rather than state: it must be readable at the moment of the tap and
   * cleared in the same breath, and it must not survive into the next shot. A
   * retake replaces exactly one draft; whatever is photographed afterwards is a
   * new item like any other.
   */
  const replacingRef = useRef<string | undefined>(route.params?.replacing);

  /**
   * The same fact as `replacingRef`, in a form the render can see.
   *
   * Two of them because they answer at different moments: the ref has to be
   * readable and clearable within the tick of the tap, and a re-render is far
   * too late for that, while the header label only exists to be drawn. The same
   * split the save guard in the editor already makes, for the same reason.
   */
  const [retaking, setRetaking] = useState(Boolean(route.params?.replacing));

  // Spend the cold start while the camera is opening rather than on whatever
  // gets photographed first. Costs nothing and is allowed to fail — see
  // `warmProxy`.
  useEffect(() => {
    warmProxy();
  }, []);

  function handleOpenResult(scan: PendingScan) {
    // The fallback covers the one case the queue cannot produce a draft for — a
    // runner that threw outright — so even that opens a usable editor rather
    // than a blank one. Same prefill Home uses for the same case.
    navigation.navigate('Add', {
      prefill: scan.prefill ?? emptyPrefill('photo', failureMessage('server')),
      scanId: scan.scanId,
    });
  }

  function handleDismissResult(scan: PendingScan) {
    setDismissed((current) => new Set(current).add(scan.scanId));
  }

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
    let imageUri: string;
    let captureMs = 0;
    let resizeMs = 0;
    let stage: 'camera' | 'resize' | 'encode' = 'camera';
    try {
      const photo = await cameraRef.current.takePictureAsync({ quality: 0.8 });
      if (!photo) throw new Error('No photo captured.');
      captureMs = Date.now() - shutterAt;
      stage = 'resize';

      const resizeStartedAt = Date.now();

      // Constrain the long edge, whichever one it is. Asking for a width alone
      // is right for a portrait shot and wrong for a landscape one, where it
      // silently produced a 1200px long edge against the 1568 the model tier
      // accepts — a quarter of the linear resolution, thrown away on the
      // smallest text in the frame.
      //
      // Skipped entirely when the photo is already inside the box: there is no
      // `withoutEnlargement` here, so asking to resize a smaller image up would
      // invent pixels and cost upload for the privilege.
      const longEdge = Math.max(photo.width, photo.height);
      const resize =
        longEdge > MAX_EDGE_PX
          ? [
              photo.width >= photo.height
                ? { resize: { width: MAX_EDGE_PX } }
                : { resize: { height: MAX_EDGE_PX } },
            ]
          : [];

      // The re-encode happens either way — base64 is what goes on the wire, and
      // it is produced here. That makes this the *only* lossy step we control,
      // which is why the quality went up rather than down.
      const manipulated = await ImageManipulator.manipulateAsync(photo.uri, resize, {
        compress: JPEG_QUALITY,
        format: ImageManipulator.SaveFormat.JPEG,
        base64: true,
      });

      stage = 'encode';
      if (!manipulated.base64) throw new Error('Could not process the photo.');
      imageBase64 = manipulated.base64;
      // Kept, not discarded. This file is the draft's identity from here on —
      // the thumbnail that answers "which pack was this?" — and the queue holds
      // it until the draft is saved, discarded or retaken.
      imageUri = manipulated.uri;
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
        // Present only on a retake, and it names the draft this photo is
        // superseding. Without it a retake and an ordinary capture are
        // indistinguishable in the log, and "why is there only one row when I
        // took two photos?" has no answer.
        ...(replacingRef.current ? { replaces: replacingRef.current } : {}),
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
    const job = {
      scanId,
      imageBase64,
      imageUri,
      capture: { shutterAt, captureMs, resizeMs },
    };

    // Consumed here, so a retake replaces exactly one draft and every shot
    // after it is an ordinary new item.
    const replacing = replacingRef.current;
    replacingRef.current = undefined;

    if (replacing) {
      setRetaking(false);

      // A retake is the third outcome a scan can have, and it means the result
      // was not good enough to work with — which is exactly as informative as a
      // corrected date. Recorded before the draft goes, while its verdict is
      // still there to read.
      const superseded = scanQueue.get(replacing);
      trustTrace(replacing, 'outcome', {
        action: 'retaken',
        verdict: superseded?.trust?.verdict ?? 'none',
        blocking: superseded?.trust?.blocking ?? [],
        replacedBy: scanId,
      });

      scanQueue.replace(replacing, job);
      // The result the user was looking at is gone, and the card must not go on
      // showing it. Clearing the dismissal set too — a retake is a fresh look at
      // this screen and anything waved off earlier can reappear if it is still
      // the most recent thing to come back.
      setDismissed(new Set());
    } else {
      scanQueue.add(job);
    }

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

        {/*
          Only while a retake is still owed a photo. Someone who arrived here
          from a draft needs to know the next shot replaces it rather than
          adding one — and that the state is gone once they have taken it.
        */}
        {retaking && <Text style={styles.retakeNote}>Replacing this scan</Text>}
      </View>

      <View style={styles.preview}>
        <CameraView ref={cameraRef} style={StyleSheet.absoluteFill} facing="back" />
        {/* Four corner brackets — the only framing affordance. */}
        <View style={[styles.bracket, styles.bracketTL]} />
        <View style={[styles.bracket, styles.bracketTR]} />
        <View style={[styles.bracket, styles.bracketBL]} />
        <View style={[styles.bracket, styles.bracketBR]} />

        {/*
          Inside the preview and floating, not in the column below it. Two
          reasons, both about not disturbing the thing someone is doing: the
          controls keep their position when a result arrives mid-session, and
          the card is over the picture rather than pushing the shutter down the
          screen. It covers the bottom of the frame, which is the part of the
          preview nobody is aiming with.
        */}
        {showing && (
          <CameraResultCard
            scan={showing}
            onOpen={handleOpenResult}
            onDismiss={handleDismissResult}
          />
        )}
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

  topRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  /* No `alignSelf` any more: the row lays this out now that it can hold a
     second item, and pinning it to the top would leave it sitting above the
     retake note beside it. */
  cancelBtn: { paddingVertical: 12, paddingHorizontal: 10 },
  retakeNote: {
    fontSize: 13.5,
    fontFamily: fonts.regular,
    color: colours.cameraDim,
  },
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
