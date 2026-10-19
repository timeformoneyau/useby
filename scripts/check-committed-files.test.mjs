/** Guards for the file-name half of the CI secret check. */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { filledEnvValues, forbiddenFiles } from './check-committed-files.mjs';

test('env files are forbidden, the example is not', () => {
  assert.deepEqual(
    forbiddenFiles(['.env', '.env.local', 'sub/.env.production', '.env.example', 'src/env.ts']),
    ['.env', '.env.local', 'sub/.env.production'],
  );
});

test('signing keys and service credentials are forbidden', () => {
  const bad = [
    'android/app/release.keystore',
    'upload.jks',
    'AuthKey.p8',
    'cert.P12',
    'private-key.pem',
    'credentials.json',
    'google-services.json',
    'service-account-prod.json',
  ];
  assert.deepEqual(forbiddenFiles(bad), bad);
});

test('ordinary source and assets pass', () => {
  assert.deepEqual(
    forbiddenFiles(['App.tsx', 'assets/icon.png', 'e2e/fixtures/milk.jpg', 'keys.ts', 'package.json']),
    [],
  );
});

test('an env example with only names passes', () => {
  assert.deepEqual(filledEnvValues('# note\nEXPO_PUBLIC_A=\nB = ""\n\n'), []);
});

test('an env example with a value is caught', () => {
  assert.deepEqual(filledEnvValues('A=\nEXPO_PUBLIC_USEBY_PROXY_SECRET=abc123\r\nC="x"\n'), [
    'EXPO_PUBLIC_USEBY_PROXY_SECRET',
    'C',
  ]);
});
