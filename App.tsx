import React, { useCallback } from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import * as SplashScreen from 'expo-splash-screen';
import { useFonts } from 'expo-font';
// Imported by weight rather than from the package root. The barrel re-exports
// every weight and both italics, and Metro does not tree-shake them away: the
// root import ships all 20 files (~1.4MB) where these five are ~340KB.
import { HankenGrotesk_400Regular } from '@expo-google-fonts/hanken-grotesk/400Regular';
import { HankenGrotesk_500Medium } from '@expo-google-fonts/hanken-grotesk/500Medium';
import { HankenGrotesk_600SemiBold } from '@expo-google-fonts/hanken-grotesk/600SemiBold';
import { HankenGrotesk_700Bold } from '@expo-google-fonts/hanken-grotesk/700Bold';
import { InstrumentSerif_400Regular } from '@expo-google-fonts/instrument-serif/400Regular';
import { RootStackParamList } from './src/types';
import { colours } from './src/theme';

import MainListScreen from './src/screens/MainListScreen';
import AddItemScreen from './src/screens/AddItemScreen';
import CaptureScreen from './src/screens/CaptureScreen';

/**
 * since-fresh gated this navigator behind a Supabase auth stack and
 * bootstrapped expo-notifications here. Neither exists yet, so the app opens
 * straight onto the list — local-only, no sign-in step.
 */
const Stack = createNativeStackNavigator<RootStackParamList>();

// Hold the native splash until the typefaces are ready. Without this the first
// frame renders in the system font and visibly reflows once they load, which
// on a design this typographic reads as a bug.
SplashScreen.preventAutoHideAsync().catch(() => {
  // Already hidden, or called twice under fast refresh. Not worth failing over.
});

export default function App() {
  const [fontsLoaded, fontError] = useFonts({
    HankenGrotesk_400Regular,
    HankenGrotesk_500Medium,
    HankenGrotesk_600SemiBold,
    HankenGrotesk_700Bold,
    InstrumentSerif_400Regular,
  });

  const onLayout = useCallback(() => {
    // Proceed on error too: falling back to the system font is far better than
    // holding the splash forever over a font that failed to load.
    if (fontsLoaded || fontError) SplashScreen.hideAsync().catch(() => {});
  }, [fontsLoaded, fontError]);

  if (!fontsLoaded && !fontError) return null;

  return (
    <SafeAreaProvider onLayout={onLayout}>
      <NavigationContainer>
        {/* Every screen draws its own header in the design's own vocabulary,
            so the native stack header is off throughout. */}
        <Stack.Navigator
          screenOptions={{
            headerShown: false,
            contentStyle: { backgroundColor: colours.background },
          }}
        >
          <Stack.Screen name="Main" component={MainListScreen} />
          <Stack.Screen name="Add" component={AddItemScreen} />
          <Stack.Screen name="Capture" component={CaptureScreen} />
        </Stack.Navigator>
      </NavigationContainer>
    </SafeAreaProvider>
  );
}
