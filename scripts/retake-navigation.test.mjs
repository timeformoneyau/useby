/**
 * Retake must never leave two cameras on the stack.
 *
 * Review & Save is opened from two places: a Home draft, and the camera's
 * result card. Retake used to `replace` the editor with a camera. From Home that
 * is right (Home → Camera). From the camera it stacked a second camera on the
 * first (Home → Camera → Camera), so the first "Done" landed on the earlier
 * camera rather than Home.
 *
 * Retake now uses `popTo('Capture', { replacing })`. These tests drive the real
 * React Navigation stack router (pure JS, no React Native) through both entry
 * paths and pin the resulting stacks, so a change back to `replace`, or a
 * router upgrade that changes `popTo`, fails here rather than on a phone.
 * `@react-navigation/routers` is the router `@react-navigation/native` uses; it
 * is imported directly here only because it loads under plain Node.
 *
 * The screen side — the camera taking up a retake that arrives as new params
 * rather than a fresh mount — is covered by the `retake.yaml` emulator flow.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { StackActions, StackRouter } from '@react-navigation/routers';

const ROUTES = ['Main', 'Add', 'Capture', 'ItemDetail', 'EditItem'];
const router = StackRouter({});
const options = { routeNames: ROUTES, routeParamList: {}, routeGetIdList: {} };

function stack(...steps) {
  let state = router.getInitialState(options);
  for (const [name, params] of steps) {
    state = router.getStateForAction(state, StackActions.push(name, params), options);
  }
  return state;
}

const apply = (state, action) => router.getStateForAction(state, action, options);
const names = (state) => state.routes.map((r) => r.name);
const top = (state) => state.routes[state.index];

/** What the editor's Retake button dispatches. */
const retake = (scanId) => StackActions.popTo('Capture', { replacing: scanId });
const goBack = (state) => apply(state, { type: 'GO_BACK' });

test('retake from an editor opened off the camera card returns to that camera', () => {
  const before = stack(['Capture'], ['Add', { scanId: 'a' }]);
  const after = apply(before, retake('a'));

  assert.deepEqual(names(after), ['Main', 'Capture'], 'one camera, not two');
  assert.deepEqual(top(after).params, { replacing: 'a' });
  // The same camera instance, so its pending-scan view and result card carry on.
  assert.equal(top(after).key, before.routes[1].key);
});

test('Done after that retake lands on Home', () => {
  const after = apply(stack(['Capture'], ['Add', { scanId: 'a' }]), retake('a'));
  assert.deepEqual(names(goBack(after)), ['Main']);
});

test('retake from an editor opened off a Home draft opens a camera in its place', () => {
  const before = stack(['Add', { scanId: 'a' }]);
  const after = apply(before, retake('a'));

  assert.deepEqual(names(after), ['Main', 'Capture']);
  assert.deepEqual(top(after).params, { replacing: 'a' });
  assert.deepEqual(names(goBack(after)), ['Main']);
});

test('repeated card → editor → retake rounds never grow the stack', () => {
  let state = stack(['Capture']);
  for (const id of ['a', 'b', 'c', 'd']) {
    state = apply(state, StackActions.push('Add', { scanId: id }));
    state = apply(state, retake(id));
    assert.deepEqual(names(state), ['Main', 'Capture']);
    assert.deepEqual(top(state).params, { replacing: id });
  }
});

test('the old replace() is what produced two cameras', () => {
  // Documents the defect, so the reason for popTo is not lost.
  const before = stack(['Capture'], ['Add', { scanId: 'a' }]);
  const after = apply(before, StackActions.replace('Capture', { replacing: 'a' }));
  assert.deepEqual(names(after), ['Main', 'Capture', 'Capture']);
});

test('the editor dispatches popTo for Retake, not replace', () => {
  const source = readFileSync(new URL('../src/screens/AddItemScreen.tsx', import.meta.url), 'utf8');
  assert.match(source, /navigation\.popTo\('Capture', \{ replacing: scanId \}\)/);
  assert.doesNotMatch(source, /navigation\.replace\('Capture'/);
});

/* ---------------------------------------------------------------------------
 * Leaving the camera: Single Item capture, Finish and Cancel all use
 * popTo('Main'). Whatever shape the stack is in, that lands on Home with
 * nothing left above it.
 * ------------------------------------------------------------------------ */

const home = () => StackActions.popTo('Main');

test('a Single Item photo from Home returns straight to Home', () => {
  assert.deepEqual(names(apply(stack(['Capture']), home())), ['Main']);
});

test('a Single Item retake opened from a Home draft returns to Home', () => {
  // Home → editor → Retake swaps the editor for the camera; the photo goes Home.
  const camera = apply(stack(['Add', { scanId: 'a' }]), retake('a'));
  assert.deepEqual(names(apply(camera, home())), ['Main']);
});

test('Finish after a Multiple Items session with a card retake returns to Home', () => {
  let state = stack(['Capture']);
  state = apply(state, StackActions.push('Add', { scanId: 'a' }));
  state = apply(state, retake('a'));
  assert.deepEqual(names(apply(state, home())), ['Main']);
});

test('Home is the first screen, so going Home never leaves the app', () => {
  const state = apply(stack(), home());
  assert.deepEqual(names(state), ['Main']);
});
