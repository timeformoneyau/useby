import React, { useEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  Animated,
  Easing,
  Image,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { pendingSummary, type PendingScan } from '../domain/scan/pending';
import { colours, fonts, hit, radius } from '../theme';

/**
 * Scans from this session that have not been saved yet.
 *
 * Sits above the urgency list and is emphatically not part of it. Everything
 * here is provisional — nothing has been reviewed, nothing is stored, and a
 * scan that looks like "Chicken thighs" is a suggestion the model made about a
 * photograph, not an item anyone owns. Mixing it into the ordered list would
 * make an unreviewed guess look exactly like a saved fact, which is the one
 * thing the review-before-save rule exists to prevent.
 *
 * So it reads as a temporary tray: its own small heading, its own card, gone
 * from the screen the moment the last draft is saved or discarded. It is
 * deliberately not a fifth screen, not a tab and not a badge — the locked
 * four-screen architecture stands, and a pending scan is a *state*, not a
 * destination.
 *
 * Ordered oldest first, which is the order the items came out of the bag. That
 * is the order they are sitting on the bench in, so it is the order that makes
 * "which one is this?" answerable.
 */

const PULSE_MS = 1600;

export default function PendingScansStrip({
  scans,
  onOpen,
}: {
  scans: readonly PendingScan[];
  onOpen: (scan: PendingScan) => void;
}) {
  /**
   * A looping animation is exactly what reduce-motion exists to suppress, and
   * this one has no dismiss. Checked once here and passed down rather than
   * subscribed to per row.
   */
  const [reduceMotion, setReduceMotion] = useState(false);

  useEffect(() => {
    let active = true;
    AccessibilityInfo.isReduceMotionEnabled().then((enabled) => {
      if (active) setReduceMotion(enabled);
    });
    const subscription = AccessibilityInfo.addEventListener(
      'reduceMotionChanged',
      setReduceMotion,
    );
    return () => {
      active = false;
      subscription.remove();
    };
  }, []);

  if (scans.length === 0) return null;

  const checking = scans.filter(
    (scan) => scan.status === 'queued' || scan.status === 'active',
  ).length;

  return (
    <View style={styles.block}>
      <View style={styles.heading}>
        <Text style={styles.headingLabel}>JUST SCANNED</Text>
        {checking > 0 && <Text style={styles.headingCount}>{checking} checking</Text>}
      </View>

      <View style={styles.card}>
        {scans.map((scan, index) => (
          <PendingRow
            key={scan.scanId}
            scan={scan}
            onOpen={onOpen}
            reduceMotion={reduceMotion}
            isLast={index === scans.length - 1}
          />
        ))}
      </View>
    </View>
  );
}

function PendingRow({
  scan,
  onOpen,
  reduceMotion,
  isLast,
}: {
  scan: PendingScan;
  onOpen: (scan: PendingScan) => void;
  reduceMotion: boolean;
  isLast: boolean;
}) {
  const { title, note, tappable } = pendingSummary(scan);
  const waiting = scan.status === 'queued' || scan.status === 'active';
  const failed = scan.status === 'failed';

  const body = (
    <View style={[styles.row, !isLast && styles.rowDivided]}>
      {waiting ? (
        <PulseDot reduceMotion={reduceMotion} />
      ) : (
        <View style={[styles.dot, failed ? styles.dotFailed : styles.dotReady]} />
      )}

      {/*
        The photograph, and it is load-bearing rather than decorative. Three
        packs of mince read as three identical rows saying `Beef mince`; the
        pictures of the actual packs tell them apart at a glance. That was the
        specific failure the real-device test surfaced.

        Shown for a scan still in flight too — the photo exists from the shutter,
        and seeing which item is being read is half of knowing the app kept up.
        A missing file (the OS may reclaim the cache) degrades to a plain block:
        the row still works and the draft is still openable.
      */}
      {scan.imageUri ? (
        <Image source={{ uri: scan.imageUri }} style={styles.thumb} />
      ) : (
        <View style={[styles.thumb, styles.thumbMissing]} />
      )}

      <View style={styles.rowText}>
        <Text style={[styles.rowTitle, waiting && styles.rowTitleWaiting]} numberOfLines={1}>
          {title}
        </Text>
        {note.length > 0 && <Text style={styles.rowNote}>{note}</Text>}
      </View>
    </View>
  );

  // A scan still in flight has nothing behind it to open, so it is not a
  // target — a row that responds to a tap by doing nothing is worse than one
  // that plainly is not ready.
  if (!tappable) return body;

  return (
    <TouchableOpacity
      onPress={() => onOpen(scan)}
      accessibilityRole="button"
      accessibilityLabel={note.length > 0 ? `${title}. ${note}` : title}
    >
      {body}
    </TouchableOpacity>
  );
}

/**
 * The one moving thing on Home.
 *
 * Says "this is still happening" and nothing more. No bar, no percentage, no
 * step sequence — the wait is the model's and its length is unknowable from
 * here, so any of those would be a number invented to fill the silence.
 * Opacity only, so it runs on the native driver and keeps breathing while the
 * list is being rebuilt.
 */
function PulseDot({ reduceMotion }: { reduceMotion: boolean }) {
  const pulse = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (reduceMotion) {
      pulse.setValue(1);
      return;
    }

    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 1,
          duration: PULSE_MS / 2,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(pulse, {
          toValue: 0,
          duration: PULSE_MS / 2,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [reduceMotion, pulse]);

  return (
    <Animated.View
      style={[
        styles.dot,
        styles.dotWaiting,
        { opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.3, 1] }) },
      ]}
    />
  );
}

const DOT = 8;
const THUMB = 40;

const styles = StyleSheet.create({
  /* No horizontal padding: inside the list this renders within a content
     container that already provides it, and doubling it would step the strip in
     from the rows it sits above. The empty-state caller pads instead. */
  block: { paddingTop: 4 },

  heading: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 8,
    paddingHorizontal: 10,
    paddingTop: 8,
    paddingBottom: 6,
  },
  headingLabel: {
    fontSize: 12.5,
    fontFamily: fonts.semibold,
    letterSpacing: 0.38,
    color: colours.label,
  },
  headingCount: { fontSize: 12, fontFamily: fonts.regular, color: colours.textMuted },

  /* Same card vocabulary as a list group, so the strip reads as part of the
     screen rather than as an alert bolted onto the top of it. */
  card: {
    backgroundColor: colours.card,
    borderWidth: 1,
    borderColor: colours.cardBorder,
    borderRadius: radius.group,
    overflow: 'hidden',
  },

  row: {
    minHeight: hit.minTarget,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 11,
    paddingHorizontal: 15,
    paddingVertical: 10,
  },
  rowDivided: { borderBottomWidth: 1, borderBottomColor: colours.divider },

  dot: { width: DOT, height: DOT, borderRadius: DOT / 2 },
  dotWaiting: { backgroundColor: colours.barLater },
  dotReady: { backgroundColor: colours.sage },
  // Clay, not terracotta: this is "worth a look", not urgency. Terracotta means
  // one thing in this app — today or already past — and a scan that failed to
  // read is not a date at all.
  dotFailed: { backgroundColor: colours.clayBorder },

  thumb: {
    width: THUMB,
    height: THUMB,
    borderRadius: 7,
    backgroundColor: colours.divider,
  },
  thumbMissing: { opacity: 0.5 },

  rowText: { flex: 1, gap: 2 },
  rowTitle: {
    fontSize: 15.5,
    fontFamily: fonts.medium,
    letterSpacing: -0.16,
    color: colours.ink,
  },
  rowTitleWaiting: { color: colours.textSecondary, fontFamily: fonts.regular },
  rowNote: { fontSize: 13, fontFamily: fonts.regular, color: colours.textSecondary },
});
