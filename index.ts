// First, so the CI flow-test build's test mode is in place before the app
// loads. Empty in every real build; see the file for why.
import './src/testing/e2eHook';
import { registerRootComponent } from 'expo';

import App from './App';

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
registerRootComponent(App);
