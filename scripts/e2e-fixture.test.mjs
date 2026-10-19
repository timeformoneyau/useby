/** The embedded fixture the fake camera uses must be the committed JPEG. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('e2e/app/fixtureImage.ts matches e2e/fixtures/label-milk.jpg', () => {
  const jpg = readFileSync('e2e/fixtures/label-milk.jpg').toString('base64');
  const ts = readFileSync('e2e/app/fixtureImage.ts', 'utf8');
  const embedded = [...ts.matchAll(/^ {2}'([A-Za-z0-9+/=]+)',$/gm)].map((m) => m[1]).join('');
  assert.equal(embedded, jpg, 'Run: node e2e/scripts/embed-fixture.mjs');
});
