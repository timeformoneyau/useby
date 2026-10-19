import React, { useEffect, useRef } from 'react';
import { AppState, StyleSheet, Text, TouchableOpacity } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Updates from 'expo-updates';
import { colours, fonts, radius } from '../theme';

/**
 * "New version ready — tap to restart".
 *
 * expo-updates checks for a new release on launch and downloads it in the
 * background, but by default only applies it on the *next* cold start. Without
 * this, the person testing a fresh release is quietly still on the old one and
 * has no way to tell. So: say when one is waiting, and let a tap apply it.
 *
 * It also checks again whenever the app comes back to the foreground, because
 * a phone app is resumed far more often than it is cold-started, and a release
 * published while it sat in the background would otherwise wait for a restart
 * nobody knows to do.
 *
 * Renders nothing when updates are off — local development, and the CI
 * flow-test build — so it can never get in the way of either.
 */
export default function UpdateBanner() {
  const insets = useSafeAreaInsets();
  const { isUpdatePending } = Updates.useUpdates();
  const checking = useRef(false);

  useEffect(() => {
    if (!Updates.isEnabled) return;

    const sub = AppState.addEventListener('change', async (state) => {
      if (state !== 'active' || checking.current) return;
      checking.current = true;
      try {
        const check = await Updates.checkForUpdateAsync();
        if (check.isAvailable) await Updates.fetchUpdateAsync();
      } catch {
        // Offline, or the update server is unreachable. The next foreground
        // tries again; there is nothing useful to tell the user about it.
      } finally {
        checking.current = false;
      }
    });
    return () => sub.remove();
  }, []);

  if (!Updates.isEnabled || !isUpdatePending) return null;

  return (
    <TouchableOpacity
      style={[styles.banner, { top: insets.top + 8 }]}
      onPress={() => Updates.reloadAsync().catch(() => {})}
      accessibilityRole="button"
      accessibilityLabel="New version ready. Tap to restart."
    >
      <Text style={styles.text}>New version ready — tap to restart</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  banner: {
    position: 'absolute',
    left: 14,
    right: 14,
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: radius.button,
    backgroundColor: colours.sage,
    alignItems: 'center',
    elevation: 6,
    shadowColor: colours.ink,
    shadowOpacity: 0.2,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 4 },
  },
  text: {
    fontSize: 14.5,
    fontFamily: fonts.semibold,
    color: colours.onSage,
  },
});
