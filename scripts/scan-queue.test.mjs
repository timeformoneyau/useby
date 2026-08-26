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
  countsLine,
  createScanQueue,
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
  capture: { shutterAt, captureMs: 10, resizeMs: 20 },
});

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
