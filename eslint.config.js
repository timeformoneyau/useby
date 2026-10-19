// Expo's own lint rules, unmodified. `npm run lint` runs them; CI fails on any
// error or warning, so a new warning is fixed when it appears rather than
// joining a pile nobody reads.
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

module.exports = defineConfig([
  expoConfig,
  { ignores: ['dist/*', 'android/*', 'ios/*', '.expo/*'] },
  {
    rules: {
      // Off on purpose. It flags `useRef(new Animated.Value(0)).current` read
      // during render, which is React Native's documented Animated idiom (the
      // value is a stable native-driven handle, not render state). Every hit in
      // this codebase is that idiom; rewriting working animations to satisfy a
      // rule aimed at web refs would be churn with real regression risk.
      'react-hooks/refs': 'off',
    },
  },
]);
