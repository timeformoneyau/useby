import React from 'react';
import { Image, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { cameraResultLine, type PendingScan } from '../domain/scan/pending';
import { longDate, shortDate } from '../domain/items/presentation';
import { parseDate } from '../utils/dateUtils';
import { colours, fonts, hit, radius } from '../theme';

/**
 * The result of the scan that just came back, shown on the camera.
 *
 * This is the answer to what the real-device test found: recognition was fast
 * enough, but results only appeared on Home, which nobody visits until the
 * shopping is put away. By then the packs are in the fridge and "which of these
 * three is the mince?" has no answer. Landing the result here, a couple of
 * seconds after the shutter, puts it in front of someone who is still holding
 * the thing it describes.
 *
 * The photograph is the point. `Beef mince` distinguishes nothing when there
 * are three of them on the bench; the picture of the actual pack distinguishes
 * all three instantly, and it costs a thumbnail.
 *
 * What this deliberately is not:
 *
 * - **Not a queue.** One card, the most recently settled scan. A list here
 *   would grow through an unpacking session until it was the screen, and Home
 *   already holds every outstanding draft.
 * - **Not a prompt.** Nothing is blocked, nothing is modal, and ignoring it
 *   entirely is a supported way to use the camera. It floats over the preview
 *   rather than sitting in the layout, so it cannot push the shutter around or
 *   change where the controls are between shots.
 * - **Not a save.** Tapping opens the same Review & Save editor as Home. There
 *   is no path from this card into storage, which is the trust rule holding
 *   until the confidence work is done and validated.
 *
 * Dismiss is not destructive and says so: the draft stays on Home either way.
 * That is what earns it a plain × with no confirmation.
 */

const THUMB = 46;

export default function CameraResultCard({
  scan,
  onOpen,
  onDismiss,
}: {
  scan: PendingScan;
  onOpen: (scan: PendingScan) => void;
  onDismiss: (scan: PendingScan) => void;
}) {
  // Injected rather than imported inside `pending.ts`, which has no value
  // imports so the offline suite can load it. See `cameraResultLine`.
  const { title, detail, tone } = cameraResultLine(scan, (iso) =>
    shortDate(parseDate(iso)),
  );

  const spoken = spokenLabel(scan, title, detail);

  return (
    <View style={styles.shell} pointerEvents="box-none">
      <TouchableOpacity
        style={styles.card}
        onPress={() => onOpen(scan)}
        accessibilityRole="button"
        accessibilityLabel={spoken}
        accessibilityHint="Opens this scan to review and save it"
      >
        {scan.imageUri ? (
          <Image source={{ uri: scan.imageUri }} style={styles.thumb} />
        ) : (
          // The cache directory can be reclaimed by the OS. A missing file
          // costs the thumbnail and nothing else — never the card, and never
          // the draft behind it.
          <View style={[styles.thumb, styles.thumbMissing]} />
        )}

        <View style={styles.text}>
          <Text style={styles.title} numberOfLines={1}>
            {title}
          </Text>
          <Text
            style={[styles.detail, tone === 'attention' && styles.detailAttention]}
            numberOfLines={1}
          >
            {detail}
          </Text>
        </View>
      </TouchableOpacity>

      <TouchableOpacity
        style={styles.dismiss}
        onPress={() => onDismiss(scan)}
        accessibilityRole="button"
        accessibilityLabel="Hide this result"
        accessibilityHint="Keeps the scan on the home screen to review later"
      >
        <Text style={styles.dismissMark}>×</Text>
      </TouchableOpacity>
    </View>
  );
}

/**
 * What a screen reader says instead of reading a card.
 *
 * The visible date is deliberately short — `3 Sep` beside a photograph is
 * unambiguous when you are holding the pack. Spoken with no photograph to go on
 * it is not, so the full date is read instead.
 */
function spokenLabel(scan: PendingScan, title: string, detail: string): string {
  const date = scan.prefill?.expiryDate;
  if (!date) return `${title}. ${detail}`;
  return `${title}. ${longDate(parseDate(date))}`;
}

const styles = StyleSheet.create({
  /* Floats over the bottom of the preview rather than joining the layout: the
     controls below must not move when a result arrives mid-session. */
  shell: {
    position: 'absolute',
    left: 10,
    right: 10,
    bottom: 10,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colours.card,
    borderRadius: radius.chip,
    borderWidth: 1,
    borderColor: colours.cardBorder,
    overflow: 'hidden',
  },

  card: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 11,
    paddingLeft: 8,
    paddingRight: 4,
    paddingVertical: 8,
    minHeight: hit.minTarget,
  },

  thumb: {
    width: THUMB,
    height: THUMB,
    borderRadius: 8,
    backgroundColor: colours.cameraPanel,
  },
  thumbMissing: { opacity: 0.35 },

  text: { flex: 1, gap: 2 },
  title: {
    fontSize: 15.5,
    fontFamily: fonts.medium,
    letterSpacing: -0.16,
    color: colours.ink,
  },
  detail: { fontSize: 13, fontFamily: fonts.regular, color: colours.textSecondary },
  /* Clay, not terracotta: "worth a look", not urgency. Terracotta means one
     thing in this app — today or already past — and a scan that read badly is
     not a date at all. */
  detailAttention: { color: colours.clayText },

  dismiss: {
    width: hit.minTarget,
    minHeight: hit.minTarget,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dismissMark: {
    fontSize: 20,
    lineHeight: 24,
    fontFamily: fonts.regular,
    color: colours.textMuted,
  },
});
