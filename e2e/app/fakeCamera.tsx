/**
 * Stand-in for `expo-camera`, swapped in by metro.config.js for the CI
 * flow-test build only. Production builds never resolve this file.
 *
 * It replaces exactly the two things CaptureScreen takes from expo-camera:
 * the viewfinder and the permission hook. The shutter returns a real JPEG
 * written to a real cache file, so everything after it — the resize, the
 * base64 encode, the request, the mapping, the editor — runs the production
 * code unchanged.
 *
 * Not covered, by design: the real camera, real autofocus, real lighting.
 * Those stay a by-hand check on a phone.
 */
import React, { forwardRef, useImperativeHandle } from 'react';
import { Image, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import { FIXTURE_JPEG_BASE64 } from './fixtureImage';
import { E2E_MARKER, currentScenario } from './scenarios';

interface FakeCameraHandle {
  takePictureAsync(): Promise<{ uri: string; width: number; height: number }>;
}

export const CameraView = forwardRef<FakeCameraHandle, { style?: StyleProp<ViewStyle> }>(
  function FakeCameraView({ style }, ref) {
    useImperativeHandle(ref, () => ({
      async takePictureAsync() {
        const uri = `${FileSystem.cacheDirectory}e2e-fixture.jpg`;
        await FileSystem.writeAsStringAsync(uri, FIXTURE_JPEG_BASE64, {
          encoding: FileSystem.EncodingType.Base64,
        });
        return { uri, width: 600, height: 800 };
      },
    }));

    return (
      <View style={[style, styles.frame]} accessibilityLabel={E2E_MARKER}>
        <Image
          source={{ uri: `data:image/jpeg;base64,${FIXTURE_JPEG_BASE64}` }}
          style={StyleSheet.absoluteFill}
          resizeMode="contain"
        />
        <Text style={styles.tag}>{`Test camera · ${currentScenario()}`}</Text>
      </View>
    );
  },
);

const GRANTED = { granted: true, status: 'granted', canAskAgain: true, expires: 'never' } as const;

export function useCameraPermissions() {
  return [GRANTED, async () => GRANTED, async () => GRANTED] as const;
}

const styles = StyleSheet.create({
  frame: { backgroundColor: '#000' },
  tag: {
    position: 'absolute',
    bottom: 8,
    alignSelf: 'center',
    color: '#fff',
    backgroundColor: 'rgba(0,0,0,0.6)',
    paddingHorizontal: 8,
    paddingVertical: 2,
    fontSize: 12,
  },
});
