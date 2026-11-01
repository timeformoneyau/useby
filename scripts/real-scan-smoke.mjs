/**
 * One real scan, end to end: the fixture label goes to the deployed proxy,
 * which asks Claude to read it. Catches the proxy, its key, or the model's
 * reading breaking — the things the emulator flows deliberately stub out.
 *
 * Costs one proxy call (at most two model calls, counting the proxy's own
 * retry), so it runs weekly or by hand, never per push. See
 * .github/workflows/real-scan.yml for the cap.
 *
 * Needs EXPO_PUBLIC_USEBY_PROXY_SECRET (and optionally _URL) in the
 * environment. Run: node --experimental-strip-types scripts/real-scan-smoke.mjs
 */
import { readFileSync } from 'node:fs';

import { parseExpiryUrl, proxySecret } from '../src/config/proxy.ts';
import { describeRead, readFields, toPrefill } from '../src/domain/scan/mapping.ts';

const EXPECTED = { name: /milk/i, date: '2027-03-15', dateType: 'use_by' };

if (!proxySecret) {
  console.error('EXPO_PUBLIC_USEBY_PROXY_SECRET is not set; cannot call the real proxy.');
  process.exit(1);
}

const image = readFileSync(new URL('../e2e/fixtures/label-milk.jpg', import.meta.url));
const scanId = `ci-real-${Date.now().toString(36)}`;
const started = Date.now();

const response = await fetch(parseExpiryUrl, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${proxySecret}`,
    'X-UseBy-Scan-Id': scanId,
  },
  body: JSON.stringify({ imageBase64: image.toString('base64') }),
  signal: AbortSignal.timeout(30_000),
});

const ms = Date.now() - started;
console.log(`scanId=${scanId} status=${response.status} totalMs=${ms} ` +
  `serverMs=${response.headers.get('X-UseBy-Server-Ms')} modelMs=${response.headers.get('X-UseBy-Model-Ms')}`);

if (!response.ok) {
  console.error(`Proxy returned ${response.status}. Check the proxy's Vercel log for id ${scanId}.`);
  process.exit(1);
}

const fields = readFields(await response.json());
if (!fields) {
  console.error('Response did not match the contract the app expects.');
  process.exit(1);
}

const prefill = toPrefill(fields);
console.log(`read=${describeRead(fields)} name="${prefill.name}" date=${prefill.expiryDate} type=${prefill.dateType}`);

const problems = [];
if (!EXPECTED.name.test(prefill.name)) problems.push(`name "${prefill.name}" does not mention milk`);
if (prefill.expiryDate !== EXPECTED.date) problems.push(`date ${prefill.expiryDate}, expected ${EXPECTED.date}`);
if (prefill.dateType !== EXPECTED.dateType) problems.push(`date type ${prefill.dateType}, expected ${EXPECTED.dateType}`);

if (problems.length) {
  console.error('The scan worked but read the label wrong:\n  ' + problems.join('\n  '));
  process.exit(1);
}
console.log('Real scan OK.');
