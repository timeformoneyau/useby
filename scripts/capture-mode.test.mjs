/**
 * Single Item / Multiple Items: the rules, pinned.
 *
 * The screen wiring (CaptureScreen) is exercised end to end by the
 * `capture-modes.yaml` emulator flow; these hold the decisions it reads.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  CAPTURE_MODES,
  DEFAULT_CAPTURE_MODE,
  afterCapture,
  cameraExits,
  finishLabel,
} from '../src/domain/scan/captureMode.ts';

test('a fresh visit to the camera starts in Single Item', () => {
  assert.equal(DEFAULT_CAPTURE_MODE, 'single');
});

test('the selector offers exactly the two modes, Single first', () => {
  assert.deepEqual(
    CAPTURE_MODES.map((m) => [m.mode, m.label]),
    [
      ['single', 'Single item'],
      ['multiple', 'Multiple items'],
    ],
  );
});

test('Single Item returns Home after a photo; Multiple Items stays', () => {
  assert.equal(afterCapture('single'), 'return-home');
  assert.equal(afterCapture('multiple'), 'stay');
});

test('there is always a way out without capturing anything', () => {
  for (const mode of ['single', 'multiple']) {
    const exits = cameraExits(mode, 0);
    assert.equal(exits.cancel, true, mode);
    assert.equal(exits.finish, false, mode);
  }
});

test('once a Multiple Items session has photos, Finish replaces Cancel', () => {
  assert.deepEqual(cameraExits('multiple', 1), { cancel: false, finish: true });
  assert.deepEqual(cameraExits('multiple', 7), { cancel: false, finish: true });
});

test('Single Item never shows Finish — a photo already leaves the camera', () => {
  assert.deepEqual(cameraExits('single', 3), { cancel: true, finish: false });
});

test('Finish counts this visit\'s photos', () => {
  assert.equal(finishLabel(0), 'Finish');
  assert.equal(finishLabel(1), 'Finish (1)');
  assert.equal(finishLabel(4), 'Finish (4)');
});

/*
 * The wiring, checked at the source. Cheap guards against the two regressions
 * that would quietly undo this work: the camera forgetting to go Home after a
 * Single Item photo, or a mode surviving between visits because it was moved
 * somewhere longer-lived than the screen.
 */
const capture = readFileSync(
  new URL('../src/screens/CaptureScreen.tsx', import.meta.url),
  'utf8',
);

test('the camera consults afterCapture once the photo is in the queue', () => {
  const enqueued = capture.lastIndexOf('scanQueue.add(job)');
  const decided = capture.indexOf("afterCapture(mode) === 'return-home'");
  assert.ok(enqueued > 0 && decided > enqueued, 'decided after the hand-over');
});

test('the mode is per visit: component state seeded from the default', () => {
  assert.match(capture, /useState<CaptureMode>\(DEFAULT_CAPTURE_MODE\)/);
});

test('every way out of the camera goes to Home', () => {
  assert.match(capture, /navigation\.popTo\('Main'\)/);
  assert.doesNotMatch(capture, /navigation\.goBack\(\)\}\s*\n\s*disabled=\{busy\}/);
});
