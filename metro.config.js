// Expo's default Metro config, plus one build-time switch for the CI
// flow-test build. Nothing here changes a production or preview bundle.
const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

/**
 * USEBY_E2E=1 is set only by the CI job that builds the emulator test app.
 * It swaps two modules at bundle time:
 *
 * - `expo-camera` -> a fake that "photographs" a fixture label
 * - the empty test hook -> the setup that stubs the proxy
 *
 * Because the swap happens when the bundle is assembled, a real build does
 * not contain the fakes at all — there is no flag to flip at runtime. CI
 * verifies that by searching the production bundle for the test marker.
 */
if (process.env.USEBY_E2E === '1') {
  const fakeCamera = path.resolve(__dirname, 'e2e/app/fakeCamera.tsx');
  const hook = path.resolve(__dirname, 'src/testing/e2eHook.ts');
  const setup = path.resolve(__dirname, 'e2e/app/setup.ts');
  const upstream = config.resolver.resolveRequest;

  config.resolver.resolveRequest = (context, moduleName, platform) => {
    if (moduleName === 'expo-camera') return { type: 'sourceFile', filePath: fakeCamera };
    const resolved = upstream
      ? upstream(context, moduleName, platform)
      : context.resolveRequest(context, moduleName, platform);
    if (resolved.type === 'sourceFile' && resolved.filePath === hook) {
      return { type: 'sourceFile', filePath: setup };
    }
    return resolved;
  };
}

module.exports = config;
