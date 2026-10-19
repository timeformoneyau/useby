/**
 * Proves the CI test mode cannot reach a real build.
 *
 * Builds the Android JS bundle twice, the way a release build does:
 *
 * - as production (no USEBY_E2E): must NOT contain the test marker
 * - as the flow-test build (USEBY_E2E=1): MUST contain it
 *
 * The second half is the control. Without it, a typo in the marker or a
 * change in how bundles are written would make the first check pass
 * vacuously, forever.
 *
 * Run: node scripts/check-bundle-isolation.mjs   (about a minute; exit 1 on failure)
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const MARKER = /export const E2E_MARKER = '([^']+)'/.exec(
  readFileSync('e2e/app/scenarios.ts', 'utf8'),
)[1];

function filesUnder(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? filesUnder(full) : [full];
  });
}

function bundleContainsMarker(env) {
  const out = mkdtempSync(path.join(tmpdir(), 'useby-bundle-'));
  try {
    execFileSync(
      'npx',
      ['expo', 'export', '--platform', 'android', '--output-dir', out, '--clear'],
      {
        stdio: ['ignore', 'ignore', 'inherit'],
        env: { ...process.env, ...env },
        // npx is a .cmd shim on Windows, which needs a shell to run.
        shell: process.platform === 'win32',
      },
    );
    const bundles = filesUnder(out).filter((f) => /\.(hbc|js)$/.test(f));
    if (bundles.length === 0) throw new Error('expo export produced no bundle');
    return bundles.some((f) => readFileSync(f).includes(MARKER));
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

const base = { USEBY_E2E: '', EXPO_PUBLIC_USEBY_PROXY_URL: '', EXPO_PUBLIC_USEBY_PROXY_SECRET: '' };

const inProduction = bundleContainsMarker(base);
const inTestBuild = bundleContainsMarker({
  ...base,
  USEBY_E2E: '1',
  EXPO_PUBLIC_USEBY_PROXY_URL: 'https://e2e.invalid',
  EXPO_PUBLIC_USEBY_PROXY_SECRET: 'e2e-placeholder',
});

if (inProduction) {
  console.error('FAIL: test-mode code is in the production bundle.');
  process.exit(1);
}
if (!inTestBuild) {
  console.error('FAIL: the flow-test bundle lacks the test marker, so this check proves nothing.');
  process.exit(1);
}
console.log('Bundle isolation OK: test mode is in the flow-test build only.');
