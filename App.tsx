import React from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { RootStackParamList } from './src/types';
import { colours } from './src/components/colours';

import MainListScreen from './src/screens/MainListScreen';
import AddItemScreen from './src/screens/AddItemScreen';
import CaptureScreen from './src/screens/CaptureScreen';

/**
 * since-fresh gated this navigator behind a Supabase auth stack and
 * bootstrapped expo-notifications here. Neither exists yet, so the app opens
 * straight onto the list — local-only, no sign-in step.
 */
const Stack = createNativeStackNavigator<RootStackParamList>();

const stackOptions = {
  headerStyle: { backgroundColor: colours.background },
  headerShadowVisible: false,
  headerTintColor: colours.textPrimary,
  headerBackTitle: 'Back',
  contentStyle: { backgroundColor: colours.background },
  headerTitleStyle: { fontWeight: '600' as const, fontSize: 17 },
};

export default function App() {
  return (
    <SafeAreaProvider>
      <NavigationContainer>
        <Stack.Navigator screenOptions={stackOptions}>
          <Stack.Screen name="Main" component={MainListScreen} options={{ headerShown: false }} />
          <Stack.Screen name="Add" component={AddItemScreen} options={{ title: 'Add an item' }} />
          <Stack.Screen
            name="Capture"
            component={CaptureScreen}
            options={{ title: 'Capture', headerShown: false }}
          />
        </Stack.Navigator>
      </NavigationContainer>
    </SafeAreaProvider>
  );
}
