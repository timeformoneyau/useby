import React, { useState } from 'react';
import { Image, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { photoTrace } from '../domain/scan/diagnostics';
import { colours } from '../theme';

/**
 * A photo, or an intentional placeholder in its place.
 *
 * One component for every thumbnail in the app — the Home row, a pending
 * draft, the camera result card and Item Detail — so "there is no photo" looks
 * the same, and deliberate, everywhere. Before this, a draft whose cache file
 * had been reclaimed, or an image that failed to decode, rendered as an empty
 * square indistinguishable from a layout bug; and saved items on Home showed no
 * photo at all.
 *
 * The placeholder is a drawn frame, not an image: nothing is fabricated or
 * regenerated, and it reads as "no photo for this one" rather than "broken".
 *
 * `uri` is `null` when there is nothing to try. When there is, a decode
 * failure falls back to the placeholder and writes one `useby.photo` line, so
 * a device run can tell a file that is missing from one that will not render.
 */
export default function PhotoThumb({
  uri,
  width,
  height,
  radius,
  label,
  where,
  file,
  tone = 'light',
  style,
}: {
  uri: string | null;
  width: number | '100%';
  height: number;
  radius: number;
  /** Spoken for a real photo, e.g. "Photo of Milk". */
  label?: string;
  where: 'home' | 'detail' | 'draft' | 'camera';
  /** What to name in the log if this fails: a stored filename or a cache URI. */
  file?: string;
  /** `dark` on the camera, where the surface behind it is near-black. */
  tone?: 'light' | 'dark';
  /** Placement only (margins). Size comes from `width` / `height`. */
  style?: StyleProp<ViewStyle>;
}) {
  // Keyed to the URI it failed for, so a new URI gets a fresh attempt without
  // an effect resetting state.
  const [failedUri, setFailedUri] = useState<string | null>(null);
  const showPhoto = uri !== null && failedUri !== uri;

  const box: ViewStyle = { width, height, borderRadius: radius, overflow: 'hidden' };

  if (showPhoto) {
    return (
      <View style={[box, styles.photoBox, style]}>
        <Image
          source={{ uri }}
          style={StyleSheet.absoluteFill}
          resizeMode="cover"
          accessibilityLabel={label}
          onError={() => {
            setFailedUri(uri);
            photoTrace('render-failed', where, file ?? uri);
          }}
        />
      </View>
    );
  }

  const inner = Math.round(Math.min(height, typeof width === 'number' ? width : height) * 0.42);
  return (
    <View
      style={[box, styles.placeholder, tone === 'dark' && styles.placeholderDark, style]}
      accessible
      accessibilityLabel="No photo"
    >
      <View
        style={[
          styles.frame,
          tone === 'dark' && styles.frameDark,
          { width: inner, height: Math.round(inner * 0.8), borderRadius: Math.max(2, inner / 8) },
        ]}
      >
        <View style={[styles.sun, tone === 'dark' && styles.sunDark]} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  photoBox: { backgroundColor: colours.divider },
  placeholder: {
    backgroundColor: colours.divider,
    borderWidth: 1,
    borderColor: colours.cardBorder,
    alignItems: 'center',
    justifyContent: 'center',
  },
  placeholderDark: {
    backgroundColor: colours.cameraPanel,
    borderColor: colours.cameraPanel,
  },
  frame: {
    borderWidth: 1.5,
    borderColor: colours.textMuted,
    alignItems: 'flex-end',
    padding: 2,
  },
  frameDark: { borderColor: colours.cameraDim },
  sun: {
    width: 3,
    height: 3,
    borderRadius: 2,
    backgroundColor: colours.textMuted,
  },
  sunDark: { backgroundColor: colours.cameraDim },
});
