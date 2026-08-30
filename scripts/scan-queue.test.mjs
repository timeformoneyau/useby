/**
 * Offline guards for the pending-scan queue.
 *
 * `pending.ts` has no value imports, so Node's type stripping loads it directly
 * and the whole state machine is exercised here with no React Native, no
 * network and no camera. That is the reason the queue is a factory rather than
 * a module singleton: every test builds its own, so nothing leaks between them.
 *
 * What these are actually protecting. Making captures non-blocking replaced one
 * scan awaited inside one screen with several running against a store that
 * outlives every screen — and the failures that introduces are all quiet ones.
 * A result attached to the wrong scan looks like a bad read. A concurrency slot
 * never released looks like a slow network. A draft dropped on a failure looks
 * like the photo never happened. None of them announce themselves on a device,
 * so they are pinned here instead.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_ACTIVE,
  cameraResultLine,
  countsLine,
  createScanQueue,
  isSettled,
  latestSettled,
  pendingSummary,
} from '../src/domain/scan/pending.ts';

const prefill = (over = {}) => ({
  name: 'Milk',
  expiryDate: '2026-08-30',
  source: 'photo',
  dateType: 'use_by',
  needsNameCheck: false,
  needsDateCheck: false,
  ...over,
});

const job = (scanId, shutterAt = 0) => ({
  scanId,
  imageBase64: `payload-${scanId}`,
  imageUri: `file:///cache/${scanId}.jpg`,
  capture: { shutterAt, captureMs: 10, resizeMs: 20 },
});

/**
 * A queue that records every image it releases.
 *
 * The release hook is how a retained photo gets deleted from the cache
 * directory, and "deleted exactly once, and only when nothing refers to it any
 * more" is not observable on a device — a file that is never cleaned up looks
 * like nothing at all until storage fills up months later. So it is asserted
 * here instead.
 */
function queueWithReleases(run, options = {}) {
  const released = [];
  // A counting clock, not the wall one. Several results can land inside the same
  // millisecond, and `settledAt` then cannot say which came back last — which is
  // the exact question the camera card asks. Ticking once per read makes the
  // order something these tests state rather than race for.
  let tick = 0;
  const queue = createScanQueue({
    run,
    onRelease: (uri) => released.push(uri),
    now: () => (tick += 1),
    ...options,
  });
  return { queue, released, at: () => tick };
}

/**
 * A runner whose every scan is resolved by hand.
 *
 * Deliberately not timer-based: out-of-order completion is the behaviour under
 * test, and it should be stated outright by the test rather than coaxed out of
 * a scheduler and hoped for.
 */
function manualRunner() {
  const calls = [];
  const run = (j) =>
    new Promise((resolve, reject) => {
      calls.push({ job: j, resolve, reject });
    });

  return {
    run,
    calls,
    get active() {
      return calls.filter((c) => !c.settled).length;
    },
    finish(scanId, outcome) {
      const call = calls.find((c) => c.job.scanId === scanId && !c.settled);
      assert.ok(call, `no in-flight call for ${scanId}`);
      call.settled = true;
      call.resolve(outcome);
      // Let the queue's own `finally` run before the test looks at it.
      return new Promise((r) => setImmediate(r));
    },
    throw(scanId, error) {
      const call = calls.find((c) => c.job.scanId === scanId && !c.settled);
      assert.ok(call, `no in-flight call for ${scanId}`);
      call.settled = true;
      call.reject(error);
      return new Promise((r) => setImmediate(r));
    },
  };
}

const ok = (over) => ({ ok: true, prefill: prefill(over) });
const failed = (notice = "Couldn't read that one.") => ({
  ok: false,
  prefill: prefill({ name: '', expiryDate: null, dateType: 'unknown', notice }),
});

const statuses = (queue) =>
  Object.fromEntries(queue.snapshot().map((s) => [s.scanId, s.status]));

test('several scans coexist, and the strip stays in shutter order', () => {
  const runner = manualRunner();
  const queue = createScanQueue({ run: runner.run });

  // Added out of order on purpose: the queue must order by when the shutter was
  // pressed, not by when it happened to hear about it.
  queue.add(job('c', 300));
  queue.add(job('a', 100));
  queue.add(job('b', 200));

  assert.deepEqual(
    queue.snapshot().map((s) => s.scanId),
    ['a', 'b', 'c'],
  );
  assert.deepEqual(queue.counts(), { checking: 3, toReview: 0 });
});

test('a result is matched to its own scan, however the order comes back', async () => {
  const runner = manualRunner();
  const queue = createScanQueue({ run: runner.run });

  queue.add(job('a', 100));
  queue.add(job('b', 200));
  queue.add(job('c', 300));

  // Last first, first last — the case that would silently mis-attribute a read
  // if anything here indexed by arrival rather than by scanId.
  await runner.finish('c', ok({ name: 'Cheese' }));
  await runner.finish('a', ok({ name: 'Apples' }));
  await runner.finish('b', ok({ name: 'Bread' }));

  assert.equal(queue.get('a').prefill.name, 'Apples');
  assert.equal(queue.get('b').prefill.name, 'Bread');
  assert.equal(queue.get('c').prefill.name, 'Cheese');
});

test('never more than the cap in flight, and finishing starts the next', async () => {
  const runner = manualRunner();
  const queue = createScanQueue({ run: runner.run, cap: 2 });

  for (const id of ['a', 'b', 'c', 'd']) queue.add(job(id));

  // Two running, two waiting their turn — and the two waiting are queued, not
  // refused. Hitting the cap must never stop someone photographing.
  assert.equal(runner.calls.length, 2);
  assert.deepEqual(statuses(queue), {
    a: 'active',
    b: 'active',
    c: 'queued',
    d: 'queued',
  });

  await runner.finish('a', ok());
  assert.equal(runner.calls.length, 3);
  assert.equal(queue.get('c').status, 'active');
  assert.equal(queue.get('d').status, 'queued');

  await runner.finish('b', ok());
  assert.equal(runner.calls.length, 4);
  assert.equal(queue.get('d').status, 'active');
});

test('a failure releases its slot too', async () => {
  const runner = manualRunner();
  const queue = createScanQueue({ run: runner.run, cap: 1 });

  queue.add(job('a'));
  queue.add(job('b'));
  assert.equal(runner.calls.length, 1);

  await runner.finish('a', failed());

  // The whole queue wedging behind one bad photo is the failure this prevents.
  assert.equal(queue.get('a').status, 'failed');
  assert.equal(runner.calls.length, 2);
  assert.equal(queue.get('b').status, 'active');
});

test('a runner that throws still releases its slot and stays reviewable', async () => {
  const runner = manualRunner();
  const queue = createScanQueue({ run: runner.run, cap: 1 });

  queue.add(job('a'));
  queue.add(job('b'));

  await runner.throw('a', new Error('unexpected'));

  assert.equal(queue.get('a').status, 'failed');
  assert.equal(runner.calls.length, 2, 'the queue kept moving');

  // No prefill to offer, but the scan is still there to be opened by hand.
  assert.equal(queue.get('a').prefill, undefined);
  assert.equal(pendingSummary(queue.get('a')).tappable, true);
});

test('a completed scan becomes reviewable and is never saved', async () => {
  const runner = manualRunner();
  const queue = createScanQueue({ run: runner.run });

  queue.add(job('a'));
  await runner.finish('a', ok({ name: 'Chicken thighs' }));

  const scan = queue.get('a');
  assert.equal(scan.status, 'ready');
  assert.equal(scan.prefill.name, 'Chicken thighs');

  // It is still sitting in the queue waiting on a person. There is no path from
  // here into item storage at all — that is the review-before-save rule, held
  // as a property of the queue rather than as a promise about the UI.
  assert.deepEqual(queue.counts(), { checking: 0, toReview: 1 });
});

test('partial reads are ready, not failures', async () => {
  const runner = manualRunner();
  const queue = createScanQueue({ run: runner.run });

  queue.add(job('name-only'));
  queue.add(job('date-only'));

  await runner.finish('name-only', ok({ name: 'Yoghurt', expiryDate: null }));
  await runner.finish('date-only', ok({ name: '' }));

  assert.equal(queue.get('name-only').status, 'ready');
  assert.equal(queue.get('date-only').status, 'ready');

  assert.deepEqual(pendingSummary(queue.get('name-only')), {
    title: 'Yoghurt',
    note: 'Add the date',
    tappable: true,
  });
  assert.deepEqual(pendingSummary(queue.get('date-only')), {
    title: 'Ready to review',
    note: 'Name it and save',
    tappable: true,
  });
});

test('an empty read reads as unreadable, not as a half-success', async () => {
  const runner = manualRunner();
  const queue = createScanQueue({ run: runner.run });

  queue.add(job('a'));
  // A well-formed 200 saying nothing was legible. The branch order in
  // `pendingSummary` is the whole point: checked after the single-field cases
  // this would render "Add the date" against a scan with no item either.
  await runner.finish('a', ok({ name: '', expiryDate: null }));

  assert.deepEqual(pendingSummary(queue.get('a')), {
    title: "Couldn't read that one",
    note: 'Tap to type it in',
    tappable: true,
  });
});

test('a scan in flight is not a tap target', () => {
  const runner = manualRunner();
  const queue = createScanQueue({ run: runner.run });

  queue.add(job('a'));
  assert.deepEqual(pendingSummary(queue.get('a')), {
    title: 'Checking…',
    note: '',
    tappable: false,
  });
});

test('removing one draft leaves the others alone', async () => {
  const runner = manualRunner();
  const queue = createScanQueue({ run: runner.run });

  queue.add(job('a', 100));
  queue.add(job('b', 200));
  queue.add(job('c', 300));
  await runner.finish('a', ok({ name: 'Apples' }));
  await runner.finish('b', ok({ name: 'Bread' }));

  queue.remove('b');

  assert.deepEqual(
    queue.snapshot().map((s) => s.scanId),
    ['a', 'c'],
  );
  assert.equal(queue.get('a').prefill.name, 'Apples');
  assert.equal(queue.get('c').status, 'active');
});

test('removing is idempotent, so a double-tapped save cannot corrupt the queue', async () => {
  const runner = manualRunner();
  const queue = createScanQueue({ run: runner.run });

  queue.add(job('a'));
  await runner.finish('a', ok());

  queue.remove('a');
  queue.remove('a');
  assert.equal(queue.snapshot().length, 0);
});

test('discarding a queued scan frees it without spending a slot', async () => {
  const runner = manualRunner();
  const queue = createScanQueue({ run: runner.run, cap: 1 });

  queue.add(job('a'));
  queue.add(job('b'));
  queue.add(job('c'));

  queue.remove('b');
  await runner.finish('a', ok());

  // 'b' was never sent; 'c' got the slot instead.
  assert.deepEqual(
    runner.calls.map((c) => c.job.scanId),
    ['a', 'c'],
  );
  assert.equal(queue.get('b'), undefined);
});

test('a result for a discarded scan is dropped rather than resurrecting it', async () => {
  const runner = manualRunner();
  const queue = createScanQueue({ run: runner.run });

  queue.add(job('a'));
  queue.remove('a');
  await runner.finish('a', ok({ name: 'Milk' }));

  // They said they did not want this one. The network finally answering is not
  // a reason to put it back.
  assert.equal(queue.get('a'), undefined);
  assert.equal(queue.snapshot().length, 0);
});

test('the same scan id cannot be added twice', () => {
  const runner = manualRunner();
  const queue = createScanQueue({ run: runner.run });

  queue.add(job('a'));
  queue.add(job('a'));

  assert.equal(queue.snapshot().length, 1);
  assert.equal(runner.calls.length, 1);
});

test('a draft never carries the image payload', async () => {
  const runner = manualRunner();
  const queue = createScanQueue({ run: runner.run });

  queue.add(job('a'));

  // The photo reaches the runner and stops there. The record the UI holds — and
  // holds for as long as the person takes to review it — is the prefill and
  // nothing else, so a run of unsaved scans is not a run of base64 strings.
  assert.equal(runner.calls[0].job.imageBase64, 'payload-a');
  assert.equal('imageBase64' in queue.get('a'), false);

  await runner.finish('a', ok());
  assert.equal('imageBase64' in queue.get('a'), false);
});

test('the snapshot keeps its identity until something actually changes', async () => {
  const runner = manualRunner();
  const queue = createScanQueue({ run: runner.run });

  queue.add(job('a'));
  const first = queue.snapshot();
  assert.equal(queue.snapshot(), first, 'a plain read must not mint a new array');

  await runner.finish('a', ok());
  assert.notEqual(queue.snapshot(), first, 'a real change must be visible');

  // `useSyncExternalStore` compares by reference: a fresh array on every read
  // re-renders forever, and an unchanged one after a mutation never re-renders
  // at all. Both are silent on a device.
});

test('subscribers are notified, and unsubscribing actually stops them', async () => {
  const runner = manualRunner();
  const queue = createScanQueue({ run: runner.run });

  let calls = 0;
  const unsubscribe = queue.subscribe(() => {
    calls += 1;
  });

  queue.add(job('a'));
  assert.ok(calls > 0);

  const afterAdd = calls;
  unsubscribe();
  await runner.finish('a', ok());

  // A screen that unmounted mid-scan must not be called back into.
  assert.equal(calls, afterAdd);
});

test('the queue keeps running after a listener throws', async () => {
  const runner = manualRunner();
  const queue = createScanQueue({ run: runner.run });

  queue.subscribe(() => {
    throw new Error('a screen blew up while rendering');
  });

  assert.throws(() => queue.add(job('a')));

  // The scan was still recorded and still sent: one broken subscriber must not
  // take the photo with it.
  assert.equal(queue.get('a').status, 'active');
  assert.equal(runner.calls.length, 1);
});

test('the shipped cap is a real number and the default is used', () => {
  const runner = manualRunner();
  const queue = createScanQueue({ run: runner.run });

  for (let i = 0; i < MAX_ACTIVE + 2; i += 1) queue.add(job(`s${i}`, i));

  assert.equal(runner.calls.length, MAX_ACTIVE);
  assert.equal(queue.counts().checking, MAX_ACTIVE + 2);
});

test('the camera line counts, and says nothing when there is nothing to say', () => {
  assert.equal(countsLine({ checking: 0, toReview: 0 }), null);
  assert.equal(countsLine({ checking: 2, toReview: 0 }), '2 checking');
  assert.equal(countsLine({ checking: 0, toReview: 3 }), '3 to review');
  assert.equal(countsLine({ checking: 1, toReview: 2 }), '1 checking · 2 to review');
});

/* -------------------------------------------------------------------------
 * Retake — one physical pack must stay one draft.
 *
 * The bug the device test found: Retake opened a bare camera, the next shutter
 * minted a fresh id and enqueued alongside the original, and the user was left
 * holding one pack of mince while looking at two rows for it. Every assertion
 * below is a way that could come back.
 * ---------------------------------------------------------------------- */

test('a retake replaces its draft instead of adding a second one', async () => {
  const runner = manualRunner();
  const { queue } = queueWithReleases(runner.run);

  queue.add(job('a', 1000));
  await runner.finish('a', ok({ name: 'Beef mince' }));

  queue.replace('a', job('a-retake', 5000));

  assert.equal(queue.snapshot().length, 1, 'one pack, one draft');
  assert.equal(queue.snapshot()[0].scanId, 'a-retake');
  assert.equal(queue.get('a'), undefined, 'the original is gone');
});

test('a retake keeps its place in the strip rather than jumping to the end', async () => {
  const runner = manualRunner();
  const { queue } = queueWithReleases(runner.run);

  queue.add(job('first', 1000));
  queue.add(job('second', 2000));
  queue.add(job('third', 3000));
  await runner.finish('first', ok({ name: 'Mince' }));

  // Retaken much later than everything else. It is still the first thing that
  // came out of the bag, and it is still sitting first on the bench.
  queue.replace('first', job('first-retake', 9000));

  assert.deepEqual(
    queue.snapshot().map((s) => s.scanId),
    ['first-retake', 'second', 'third'],
  );
  assert.equal(queue.get('first-retake').shutterAt, 1000, 'inherits the original shutter');
});

test('a retake releases the photo it superseded, and holds the new one', async () => {
  const runner = manualRunner();
  const { queue, released } = queueWithReleases(runner.run);

  queue.add(job('a', 1000));
  await runner.finish('a', ok());
  queue.replace('a', job('a-retake', 2000));

  assert.deepEqual(released, ['file:///cache/a.jpg'], 'the replaced photo, once');
  assert.equal(queue.get('a-retake').imageUri, 'file:///cache/a-retake.jpg');
});

test('a late result for a retaken scan cannot resurrect it', async () => {
  const runner = manualRunner();
  const { queue } = queueWithReleases(runner.run);

  // Retaken while the original was still in flight — impatient, but reachable.
  queue.add(job('a', 1000));
  queue.replace('a', job('a-retake', 2000));

  await runner.finish('a', ok({ name: 'Stale answer' }));

  assert.equal(queue.snapshot().length, 1);
  assert.equal(queue.snapshot()[0].scanId, 'a-retake');
  assert.equal(queue.get('a'), undefined);
});

test('a retake of a draft that is already gone still keeps the photo', async () => {
  const runner = manualRunner();
  const { queue, released } = queueWithReleases(runner.run);

  // Saved or discarded from Home while the camera was open. The retake must not
  // be swallowed just because the thing it was replacing vanished first.
  queue.replace('never-existed', job('a-retake', 4000));

  assert.equal(queue.snapshot().length, 1);
  assert.equal(queue.snapshot()[0].scanId, 'a-retake');
  assert.equal(queue.get('a-retake').shutterAt, 4000, 'falls back to its own shutter');
  assert.deepEqual(released, [], 'nothing to release');
});

test('a retake frees the slot the original was holding', async () => {
  const runner = manualRunner();
  const { queue } = queueWithReleases(runner.run);

  for (let i = 0; i < MAX_ACTIVE; i += 1) queue.add(job(`s${i}`, i));
  queue.add(job('waiting', 99));
  assert.equal(runner.calls.length, MAX_ACTIVE, 'capped');

  // Replacing an in-flight scan must not strand its concurrency slot: the
  // request is abandoned, so the slot has to come back when it settles.
  queue.replace('s0', job('s0-retake', 100));
  await runner.finish('s0', ok());

  assert.equal(runner.active, MAX_ACTIVE, 'still saturated, not stalled');
  const ids = queue.snapshot().map((s) => s.scanId);
  assert.ok(ids.includes('s0-retake'));
  assert.ok(ids.includes('waiting'));
  assert.ok(!ids.includes('s0'));
});

/* -------------------------------------------------------------------------
 * Retained image lifetime.
 * ---------------------------------------------------------------------- */

test('a draft holds its photo across settling, so the thumbnail survives', async () => {
  const runner = manualRunner();
  const { queue, released } = queueWithReleases(runner.run);

  queue.add(job('a', 1000));
  assert.equal(queue.get('a').imageUri, 'file:///cache/a.jpg', 'held from the shutter');

  await runner.finish('a', ok());

  assert.equal(
    queue.get('a').imageUri,
    'file:///cache/a.jpg',
    'still held after the request settled — the upload goes, the file stays',
  );
  assert.deepEqual(released, [], 'settling is not a release');
});

test('saving or discarding a draft releases exactly its own photo', async () => {
  const runner = manualRunner();
  const { queue, released } = queueWithReleases(runner.run);

  queue.add(job('a', 1000));
  queue.add(job('b', 2000));
  await runner.finish('a', ok());
  await runner.finish('b', ok());

  queue.remove('a');

  assert.deepEqual(released, ['file:///cache/a.jpg']);
  assert.equal(queue.get('b').imageUri, 'file:///cache/b.jpg', 'the other is untouched');
});

test('removing the same draft twice does not release its photo twice', async () => {
  const runner = manualRunner();
  const { queue, released } = queueWithReleases(runner.run);

  queue.add(job('a', 1000));
  await runner.finish('a', ok());

  queue.remove('a');
  queue.remove('a');

  assert.deepEqual(released, ['file:///cache/a.jpg'], 'once, not twice');
});

test('discarding a scan still in flight releases its photo', () => {
  const runner = manualRunner();
  const { queue, released } = queueWithReleases(runner.run);

  queue.add(job('a', 1000));
  queue.remove('a');

  assert.deepEqual(released, ['file:///cache/a.jpg']);
});

test('a queue with no release hook still works', async () => {
  // The hook is optional, and the offline suite is not the only caller.
  const runner = manualRunner();
  const queue = createScanQueue({ run: runner.run });

  queue.add(job('a', 1000));
  await runner.finish('a', ok());
  queue.remove('a');

  assert.equal(queue.snapshot().length, 0);
});

/* -------------------------------------------------------------------------
 * What the camera shows — ordered by when a scan came back, not when it was
 * photographed. Requests finish out of order routinely, and this is the whole
 * reason `settledAt` exists.
 * ---------------------------------------------------------------------- */

test('the camera shows the scan that came back most recently, not the newest photo', async () => {
  const runner = manualRunner();
  const { queue } = queueWithReleases(runner.run);

  queue.add(job('first', 1000));
  queue.add(job('second', 2000));

  // The later photograph answers first. That is the news, and it is what should
  // be on screen — ordering by shutter would show the first item's result.
  await runner.finish('second', ok({ name: 'Yoghurt' }));
  await runner.finish('first', ok({ name: 'Mince' }));

  const showing = latestSettled(queue.snapshot(), new Set());
  assert.equal(showing.scanId, 'first', 'the one that just settled');
});

test('the camera shows nothing until something has settled', () => {
  const runner = manualRunner();
  const { queue } = queueWithReleases(runner.run);

  queue.add(job('a', 1000));

  assert.equal(latestSettled(queue.snapshot(), new Set()), null);
  assert.equal(latestSettled([], new Set()), null);
});

test('a dismissed result steps aside for the one behind it', async () => {
  const runner = manualRunner();
  const { queue } = queueWithReleases(runner.run);

  queue.add(job('a', 1000));
  queue.add(job('b', 2000));
  await runner.finish('a', ok({ name: 'Mince' }));
  await runner.finish('b', ok({ name: 'Yoghurt' }));

  assert.equal(latestSettled(queue.snapshot(), new Set()).scanId, 'b');
  assert.equal(latestSettled(queue.snapshot(), new Set(['b'])).scanId, 'a');
  assert.equal(latestSettled(queue.snapshot(), new Set(['a', 'b'])), null);
});

test('dismissing a result is not discarding it', async () => {
  const runner = manualRunner();
  const { queue, released } = queueWithReleases(runner.run);

  queue.add(job('a', 1000));
  await runner.finish('a', ok());

  // Dismissal is a view concern and never touches the queue. If this ever
  // starts removing the draft, waving a card away on the camera would silently
  // throw a photograph out.
  latestSettled(queue.snapshot(), new Set(['a']));

  assert.equal(queue.snapshot().length, 1, 'the draft is untouched');
  assert.deepEqual(released, [], 'and so is its photo');
});

test('a failed scan is settled, and is shown', async () => {
  const runner = manualRunner();
  const { queue } = queueWithReleases(runner.run);

  queue.add(job('a', 1000));
  await runner.finish('a', failed());

  assert.equal(isSettled(queue.get('a')), true);
  assert.equal(latestSettled(queue.snapshot(), new Set()).scanId, 'a');
});

/* -------------------------------------------------------------------------
 * The camera card's copy. Same branch-order rule as `pendingSummary` and
 * `reviewCopy`: the empty read is tested before the single-field cases.
 * ---------------------------------------------------------------------- */

/** A stub formatter, so the composition is asserted rather than date-fns. */
const asDate = (iso) => `<${iso}>`;

const settled = (status, prefillOver) => ({
  scanId: 'x',
  status,
  shutterAt: 0,
  settledAt: 1,
  prefill: prefillOver === null ? undefined : prefill(prefillOver),
});

test('a clean read reads as the item and its date', () => {
  const line = cameraResultLine(
    settled('ready', { name: 'Beef mince', expiryDate: '2026-09-03' }),
    asDate,
  );
  assert.deepEqual(line, {
    title: 'Beef mince',
    detail: '<2026-09-03>',
    tone: 'ready',
  });
});

test('an empty read is not dressed up as a partial one', () => {
  // The branch that has now been got wrong twice elsewhere. A scan that read
  // neither field must not render as "Tap to add the date" against no item.
  const line = cameraResultLine(
    settled('ready', { name: '', expiryDate: null }),
    asDate,
  );
  assert.equal(line.title, "Couldn't read that one");
  assert.equal(line.tone, 'attention');
});

test('a partial read says which half is missing', () => {
  const noDate = cameraResultLine(settled('ready', { expiryDate: null }), asDate);
  assert.deepEqual(noDate, {
    title: 'Milk',
    detail: 'Tap to add the date',
    tone: 'attention',
  });

  const noName = cameraResultLine(settled('ready', { name: '' }), asDate);
  assert.deepEqual(noName, {
    title: '<2026-08-30>',
    detail: 'Tap to name it',
    tone: 'attention',
  });
});

test('a failure is recoverable rather than final', () => {
  const line = cameraResultLine(settled('failed', { name: '', expiryDate: null }), asDate);
  assert.equal(line.detail, 'Tap to type it in');

  // Even with no prefill at all — the runner threw — there is something to tap.
  const bare = cameraResultLine(settled('failed', null), asDate);
  assert.equal(bare.title, "Couldn't read that one");
  assert.equal(bare.tone, 'attention');
});

test('the camera card never invents a date it was not given', () => {
  // A formatter that would be obvious in the output if it were ever called on
  // a scan with no date.
  const loud = () => 'FORMATTED';
  const line = cameraResultLine(settled('ready', { expiryDate: null }), loud);
  assert.ok(!line.title.includes('FORMATTED'));
  assert.ok(!line.detail.includes('FORMATTED'));
});

test('the camera card shows this visit, not the backlog', async () => {
  const runner = manualRunner();
  const { queue, at } = queueWithReleases(runner.run);

  // Settled before the camera was opened: still a draft, still on Home, but not
  // news — greeting someone with it as they open the camera to shoot the next
  // thing would be a stale interruption.
  queue.add(job('earlier', 1000));
  await runner.finish('earlier', ok({ name: 'Yesterday' }));

  const openedAt = at() + 1;
  assert.equal(latestSettled(queue.snapshot(), new Set(), openedAt), null);

  // One started earlier but landing during this visit *is* news.
  queue.add(job('now', 2000));
  await runner.finish('now', ok({ name: 'Mince' }));
  assert.equal(latestSettled(queue.snapshot(), new Set(), openedAt).scanId, 'now');
});
