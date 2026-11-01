/**
 * Regression scenarios for capture → review → save, run as sequences rather
 * than single transitions.
 *
 * `scan-queue.test.mjs` pins each rule of the queue on its own: results match
 * by id, the cap holds, a retake replaces, a failure stays reviewable. What it
 * does not do is run them *together* the way a person does at the bench —
 * eight photos in a burst, one retaken while the others are still in the air,
 * two of them failing, then saving down the strip. These are the interactions
 * device testing has to cover today, and the ones where a slip shows up as the
 * wrong photo on the wrong item or a draft quietly gone.
 *
 * Everything here is the real `pending.ts`, `saveScan.ts` and `photos.ts`; only
 * the network runner and the filesystem are stand-ins. No React Native.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createScanQueue, latestSettled, pendingSummary } from '../src/domain/scan/pending.ts';
import { saveScannedItem } from '../src/domain/items/saveScan.ts';
import { createPhotoStore } from '../src/domain/items/photos.ts';

/* ---------------------------------------------------------------------------
 * Harness.
 * ------------------------------------------------------------------------ */

const flush = () => new Promise((r) => setImmediate(r));

/** A runner resolved by hand, so completion order is stated, not raced. */
function manualRunner() {
  const calls = [];
  return {
    calls,
    run: (job) =>
      new Promise((resolve, reject) => {
        calls.push({ job, resolve, reject, settled: false });
      }),
    inFlight() {
      return calls.filter((c) => !c.settled).map((c) => c.job.scanId);
    },
    async finish(scanId, outcome) {
      const call = calls.find((c) => c.job.scanId === scanId && !c.settled);
      assert.ok(call, `no in-flight call for ${scanId}`);
      call.settled = true;
      call.resolve(outcome);
      await flush();
    },
    async crash(scanId) {
      const call = calls.find((c) => c.job.scanId === scanId && !c.settled);
      assert.ok(call, `no in-flight call for ${scanId}`);
      call.settled = true;
      call.reject(new Error('runner threw'));
      await flush();
    },
  };
}

/** What the proxy "read" for a photo — keyed to the photo's own bytes. */
function readOf(job) {
  // The name is derived from the payload the runner was actually handed, so a
  // result can only be "right" if the right photo went with the right scan.
  const name = job.imageBase64.replace(/^payload-/, 'Item from ');
  return {
    ok: true,
    prefill: {
      name,
      expiryDate: '2026-10-20',
      dateType: 'use_by',
      source: 'photo',
      needsNameCheck: false,
      needsDateCheck: false,
    },
  };
}

const unreadable = (notice = "We couldn't read that one") => ({
  ok: false,
  prefill: {
    name: '',
    expiryDate: null,
    dateType: 'unknown',
    source: 'photo',
    needsNameCheck: true,
    needsDateCheck: true,
    notice,
  },
});

/** A shutter press: a fresh id, the bytes, and the cache file holding them. */
const shot = (scanId, shutterAt) => ({
  scanId,
  imageBase64: `payload-${scanId}`,
  imageUri: `file:///cache/${scanId}.jpg`,
  capture: { shutterAt, captureMs: 5, resizeMs: 5 },
});

/** In-memory filesystem behind the real photo store. */
function memoryFs() {
  const files = new Map();
  const fs = {
    ensureDir() {},
    copy(src, name) {
      if (!files.has(src)) throw new Error(`ENOENT ${src}`);
      files.set(`doc/${name}`, files.get(src));
    },
    delete(name) {
      files.delete(`doc/${name}`);
    },
    exists: (name) => files.has(`doc/${name}`),
    list: () => [...files.keys()].filter((k) => k.startsWith('doc/')).map((k) => k.slice(4)),
    uriFor: (name) => `file:///doc/${name}`,
  };
  return { files, fs };
}

/**
 * The app's wiring, minus React: a queue whose released images are deleted
 * from the cache, a photo store, an item list, and the editor's Save.
 */
function bench({ cap = 3 } = {}) {
  const { files, fs } = memoryFs();
  const runner = manualRunner();
  let tick = 0;
  const queue = createScanQueue({
    run: runner.run,
    cap,
    now: () => (tick += 1),
    onRelease: (uri) => files.delete(uri),
  });
  const photos = createPhotoStore(fs);
  const items = [];

  function capture(scanId, shutterAt) {
    const job = shot(scanId, shutterAt);
    files.set(job.imageUri, `bytes-of-${scanId}`); // the camera wrote it
    queue.add(job);
    return job;
  }

  function retake(previousId, scanId, shutterAt) {
    const job = shot(scanId, shutterAt);
    files.set(job.imageUri, `bytes-of-${scanId}`);
    queue.replace(previousId, job);
    return job;
  }

  /** Open a draft and press Save, optionally after the person edits it. */
  async function save(scanId, edits = {}, { createFails = false } = {}) {
    const draft = queue.get(scanId);
    assert.ok(draft, `no draft ${scanId}`);
    const base = draft.prefill ?? { name: '', expiryDate: null, dateType: 'unknown' };
    await saveScannedItem(
      {
        retain: (id, uri) => photos.retain(id, uri),
        create: async (input) => {
          if (createFails) throw new Error('storage full');
          items.push({ id: `item-${items.length + 1}`, ...input });
        },
        release: (id) => queue.remove(id),
      },
      {
        name: edits.name ?? base.name,
        expiryDate: edits.expiryDate ?? base.expiryDate,
        dateType: base.dateType,
        source: 'photo',
        scanId,
        photoUri: draft.imageUri,
      },
    );
  }

  return { queue, runner, files, photos, items, capture, retake, save };
}

const ids = (queue) => queue.snapshot().map((s) => s.scanId);

/* ---------------------------------------------------------------------------
 * Rapid consecutive capture.
 * ------------------------------------------------------------------------ */

test('a burst of eight photos inside one millisecond keeps all eight, in order', async () => {
  const b = bench({ cap: 3 });
  const burst = ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8'];

  // Same shutter time for all of them: a phone that fires faster than its own
  // clock resolution must still keep them apart and in the order taken.
  for (const id of burst) b.capture(id, 1000);

  assert.deepEqual(ids(b.queue), burst);
  assert.deepEqual(b.runner.inFlight(), ['s1', 's2', 's3'], 'cap holds during a burst');
  assert.deepEqual(b.queue.counts(), { checking: 8, toReview: 0 });
});

test('a burst drains completely, whatever order the answers come back in', async () => {
  const b = bench({ cap: 3 });
  const burst = ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8'];
  burst.forEach((id, i) => b.capture(id, 1000 + i));

  // Always answer the most recently started request first — the worst case
  // for anything that pairs results by position.
  while (b.runner.inFlight().length > 0) {
    const newest = b.runner.inFlight().at(-1);
    const call = b.runner.calls.find((c) => c.job.scanId === newest);
    await b.runner.finish(newest, readOf(call.job));
    assert.ok(b.runner.inFlight().length <= 3);
  }

  assert.equal(b.runner.calls.length, 8, 'every photo was sent exactly once');
  assert.deepEqual(b.queue.counts(), { checking: 0, toReview: 8 });
  for (const id of burst) {
    const draft = b.queue.get(id);
    assert.equal(draft.status, 'ready');
    assert.equal(draft.prefill.name, `Item from ${id}`, `${id} carries its own read`);
    assert.equal(draft.imageUri, `file:///cache/${id}.jpg`, `${id} carries its own photo`);
  }
});

test('each request is sent the bytes of its own photograph', async () => {
  const b = bench({ cap: 2 });
  ['a', 'b', 'c', 'd'].forEach((id, i) => b.capture(id, i));
  await b.runner.finish('b', readOf(b.runner.calls[1].job));
  await b.runner.finish('a', readOf(b.runner.calls[0].job));

  for (const call of b.runner.calls) {
    assert.equal(call.job.imageBase64, `payload-${call.job.scanId}`);
    assert.equal(call.job.imageUri, `file:///cache/${call.job.scanId}.jpg`);
  }
});

/* ---------------------------------------------------------------------------
 * Retake in the middle of a burst.
 * ------------------------------------------------------------------------ */

test('retaking one photo mid-burst replaces it and disturbs no other draft', async () => {
  const b = bench({ cap: 2 });
  b.capture('a', 100);
  b.capture('b', 200);
  b.capture('c', 300); // queued behind the cap
  await b.runner.finish('a', readOf(b.runner.calls[0].job));

  // 'b' is still in the air when the person decides it was a bad shot.
  b.retake('b', 'b2', 999);

  assert.deepEqual(ids(b.queue), ['a', 'b2', 'c'], 'same count, same place');
  assert.ok(!b.files.has('file:///cache/b.jpg'), 'the superseded photo is released');
  assert.ok(b.files.has('file:///cache/b2.jpg'));
  assert.equal(b.queue.get('a').prefill.name, 'Item from a', 'a is untouched');

  // The original answer arrives late and must land nowhere.
  const lateB = b.runner.calls.find((c) => c.job.scanId === 'b');
  await b.runner.finish('b', readOf(lateB.job));
  assert.equal(b.queue.get('b'), undefined);
  assert.deepEqual(ids(b.queue), ['a', 'b2', 'c']);

  for (const id of ['c', 'b2']) {
    const call = b.runner.calls.find((x) => x.job.scanId === id);
    await b.runner.finish(id, readOf(call.job));
  }
  assert.equal(b.queue.get('b2').prefill.name, 'Item from b2');
  assert.equal(b.queue.get('b2').imageUri, 'file:///cache/b2.jpg');
  assert.deepEqual(b.queue.counts(), { checking: 0, toReview: 3 });
});

test('retaking the same draft twice still leaves exactly one', async () => {
  const b = bench();
  b.capture('a', 100);
  b.retake('a', 'a2', 200);
  b.retake('a2', 'a3', 300);

  assert.deepEqual(ids(b.queue), ['a3']);
  assert.deepEqual(
    [...b.files.keys()].filter((k) => k.startsWith('file:///cache/')),
    ['file:///cache/a3.jpg'],
  );
});

test('saving a retaken draft produces one item with the retake\'s photo', async () => {
  const b = bench();
  b.capture('a', 100);
  await b.runner.finish('a', readOf(b.runner.calls[0].job));
  b.retake('a', 'a2', 200);
  await b.runner.finish('a2', readOf(b.runner.calls[1].job));

  await b.save('a2');

  assert.equal(b.items.length, 1);
  assert.equal(b.items[0].name, 'Item from a2');
  assert.equal(b.items[0].photo, 'scan-a2.jpg');
  assert.equal(b.files.get('doc/scan-a2.jpg'), 'bytes-of-a2', 'the retake\'s own bytes');
  assert.equal(b.queue.snapshot().length, 0);
});

/* ---------------------------------------------------------------------------
 * Failed recognition keeps everything the person needs to recover.
 * ------------------------------------------------------------------------ */

test('a failed read keeps its photo, its notice and its place', async () => {
  const b = bench();
  b.capture('a', 100);
  b.capture('b', 200);
  b.capture('c', 300);

  await b.runner.finish('b', unreadable());
  await b.runner.finish('a', readOf(b.runner.calls[0].job));
  await b.runner.crash('c');

  assert.deepEqual(ids(b.queue), ['a', 'b', 'c']);

  const failed = b.queue.get('b');
  assert.equal(failed.status, 'failed');
  assert.equal(failed.imageUri, 'file:///cache/b.jpg', 'thumbnail survives the failure');
  assert.ok(b.files.has('file:///cache/b.jpg'), 'and so does the file');
  assert.equal(failed.prefill.notice, "We couldn't read that one");
  assert.equal(pendingSummary(failed).tappable, true);

  const crashed = b.queue.get('c');
  assert.equal(crashed.status, 'failed');
  assert.equal(crashed.imageUri, 'file:///cache/c.jpg');
  assert.equal(pendingSummary(crashed).tappable, true);

  assert.equal(b.queue.get('a').status, 'ready', 'a neighbour\'s failure is not contagious');
});

test('a failed read can be finished by hand, and keeps its photo', async () => {
  const b = bench();
  b.capture('a', 100);
  await b.runner.finish('a', unreadable());

  await b.save('a', { name: 'Butter', expiryDate: '2026-11-02' });

  assert.equal(b.items.length, 1);
  assert.equal(b.items[0].name, 'Butter');
  assert.equal(b.items[0].photo, 'scan-a.jpg');
  assert.ok(b.files.has('doc/scan-a.jpg'));
  assert.equal(b.queue.get('a'), undefined);
});

test('a failed read can be retaken instead, without leaving a second draft', async () => {
  const b = bench();
  b.capture('a', 100);
  await b.runner.finish('a', unreadable());

  b.retake('a', 'a2', 200);
  assert.deepEqual(ids(b.queue), ['a2']);
  assert.equal(b.queue.get('a2').status, 'active');

  await b.runner.finish('a2', readOf(b.runner.calls[1].job));
  assert.equal(b.queue.get('a2').prefill.name, 'Item from a2');
});

test('a Save that fails to write keeps the draft and its photo for another go', async () => {
  const b = bench();
  b.capture('a', 100);
  await b.runner.finish('a', readOf(b.runner.calls[0].job));

  await assert.rejects(b.save('a', {}, { createFails: true }));

  const draft = b.queue.get('a');
  assert.ok(draft, 'the draft is still there');
  assert.equal(draft.status, 'ready');
  assert.ok(b.files.has('file:///cache/a.jpg'), 'its photo is still there');
  assert.equal(b.items.length, 0);

  // And the retry succeeds.
  await b.save('a');
  assert.equal(b.items.length, 1);
  assert.equal(b.items[0].photo, 'scan-a.jpg');
});

/* ---------------------------------------------------------------------------
 * Working down the strip.
 * ------------------------------------------------------------------------ */

test('saving down a burst gives every item its own photograph', async () => {
  const b = bench({ cap: 3 });
  const burst = ['s1', 's2', 's3', 's4', 's5'];
  burst.forEach((id, i) => b.capture(id, 100 + i));
  // Alternate oldest / newest in flight, so answers interleave with the queue.
  for (let n = 0; b.runner.inFlight().length > 0; n += 1) {
    const flying = b.runner.inFlight();
    const id = n % 2 ? flying[0] : flying.at(-1);
    const call = b.runner.calls.find((c) => c.job.scanId === id && !c.settled);
    await b.runner.finish(id, readOf(call.job));
  }

  // Saved out of order, the way someone picks from a strip.
  for (const id of ['s3', 's1', 's5', 's2', 's4']) await b.save(id);

  assert.equal(b.items.length, 5);
  for (const item of b.items) {
    const scanId = item.name.replace('Item from ', '');
    assert.equal(item.photo, `scan-${scanId}.jpg`);
    assert.equal(b.files.get(`doc/${item.photo}`), `bytes-of-${scanId}`);
  }
  assert.equal(b.queue.snapshot().length, 0);
  assert.deepEqual(
    [...b.files.keys()].filter((k) => k.startsWith('file:///cache/')),
    [],
    'every temporary image was released',
  );
});

test('the camera card follows the latest answer while drafts are being saved', async () => {
  const b = bench();
  b.capture('a', 100);
  b.capture('b', 200);
  await b.runner.finish('b', readOf(b.runner.calls[1].job));
  await b.runner.finish('a', readOf(b.runner.calls[0].job));

  assert.equal(latestSettled(b.queue.snapshot(), new Set()).scanId, 'a');
  await b.save('a');
  assert.equal(
    latestSettled(b.queue.snapshot(), new Set()).scanId,
    'b',
    'once a is saved the card falls back to b, never to nothing',
  );
});

/* ---------------------------------------------------------------------------
 * Leaving the camera does not touch the queue.
 *
 * Single Item mode returns Home the moment the photo is queued, and Finish
 * returns Home with scans still in flight. Both rely on the queue being owned
 * by nothing on screen: the camera unsubscribing must not stop, drop or
 * reorder anything, and Home subscribing afterwards must see every draft.
 * ------------------------------------------------------------------------ */

test('scans finish after the camera has gone, and Home sees every draft', async () => {
  const b = bench({ cap: 3 });
  let cameraSaw = 0;
  const leaveCamera = b.queue.subscribe(() => {
    cameraSaw += 1;
  });

  b.capture('a', 100);
  b.capture('b', 200);
  b.capture('c', 300);
  b.capture('d', 400); // waits for a slot
  leaveCamera(); // Finish (or a Single Item photo) — back to Home

  let homeSaw = 0;
  b.queue.subscribe(() => {
    homeSaw += 1;
  });

  // Answers come back out of order, after the camera has gone.
  for (const id of ['c', 'a', 'd', 'b']) {
    while (!b.runner.inFlight().includes(id)) {
      const first = b.runner.inFlight()[0];
      const call = b.runner.calls.find((x) => x.job.scanId === first && !x.settled);
      await b.runner.finish(first, readOf(call.job));
    }
    const call = b.runner.calls.find((x) => x.job.scanId === id && !x.settled);
    if (call) await b.runner.finish(id, readOf(call.job));
  }

  assert.ok(cameraSaw > 0);
  assert.ok(homeSaw > 0, 'Home is told as each answer lands');
  assert.deepEqual(ids(b.queue), ['a', 'b', 'c', 'd'], 'shutter order, nothing dropped');
  for (const id of ['a', 'b', 'c', 'd']) {
    assert.equal(b.queue.get(id).status, 'ready');
    assert.equal(b.queue.get(id).prefill.name, `Item from ${id}`);
    assert.equal(b.queue.get(id).imageUri, `file:///cache/${id}.jpg`);
  }
  assert.equal(b.items.length, 0, 'nothing saved without review');
});
