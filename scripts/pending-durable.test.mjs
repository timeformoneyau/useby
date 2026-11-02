/**
 * Durable pending scans: photographed drafts survive the app being killed.
 *
 * Everything here is the real code — the queue (`pending.ts`), its SQLite
 * adapter (`pendingStore.ts`), the item database, `saveScannedItem` and the
 * photo store — run against **real SQLite** on a file (`node:sqlite`) and an
 * in-memory filesystem. Only the network runner is a stand-in, so a test can
 * decide when (and whether) recognition answers.
 *
 * A "restart" is what process death leaves behind: the database file and the
 * files on disk, and nothing else. `boot()` builds a fresh connection, store
 * and queue over them, exactly as a cold start does, and runs the same restore
 * and sweep the app runs.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createNodeDriver } from './support/fakes.mjs';
import { createItemDatabase } from '../src/domain/items/db/itemDatabase.ts';
import {
  createScanQueue,
  pendingSummary,
  MAX_DRAFT_AGE_MS,
  STALE_MS,
} from '../src/domain/scan/pending.ts';
import {
  createPendingStore,
  orphanPendingFiles,
  pendingFilename,
  rowToScan,
  scanToRow,
} from '../src/domain/scan/pendingStore.ts';
import { saveScannedItem } from '../src/domain/items/saveScan.ts';
import { createPhotoStore } from '../src/domain/items/photos.ts';

const PENDING = 'file:///doc/pending/';
const PHOTOS = 'file:///doc/photos/';
const T0 = Date.UTC(2026, 10, 2, 9, 0, 0);

/* ---------------------------------------------------------------------------
 * The world a process runs in, and what survives it.
 * ------------------------------------------------------------------------ */

const cleanups = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()();
});

/** What survives process death: one database file and one filesystem. */
function device() {
  const dir = mkdtempSync(join(tmpdir(), 'useby-pending-'));
  const disk = new Map(); // uri -> contents
  const state = { path: join(dir, 'useby.db'), disk, clock: T0, drivers: [] };
  cleanups.push(() => {
    for (const d of state.drivers) {
      try {
        d.close();
      } catch {
        // already closed
      }
    }
    rmSync(dir, { recursive: true, force: true });
  });
  return state;
}

const pendingFiles = (disk) => ({
  fileOf(uri) {
    return uri.startsWith(PENDING) ? uri.slice(PENDING.length) : null;
  },
  uriOf(name) {
    return disk.has(PENDING + name) ? PENDING + name : null;
  },
});

/** A recognition request the test answers by hand. */
function controllableRunner() {
  const calls = [];
  const run = (job) =>
    new Promise((resolve, reject) => {
      calls.push({ job, resolve, reject });
    });
  return { run, calls };
}

const READY = (name, expiryDate = '2026-11-09') => ({
  ok: true,
  prefill: {
    name,
    expiryDate,
    source: 'photo',
    dateType: 'use_by',
    needsNameCheck: false,
    needsDateCheck: false,
  },
  trust: { verdict: 'review', blocking: ['no_evidence'], advisory: [], derived: { iso: null, format: 'none', dateType: null } },
});

/**
 * Boot the app's pending-scan machinery over a device: open the database,
 * restore, sweep. Mirrors `restorePendingScans` in `queue.ts`.
 */
async function boot(dev, { runner = controllableRunner(), driver, staleMs } = {}) {
  const drv = driver ?? createNodeDriver(dev.path);
  dev.drivers.push(drv);
  const db = createItemDatabase({ driver: drv, now: () => new Date(dev.clock).toISOString() });
  const files = pendingFiles(dev.disk);
  const errors = [];
  const store = createPendingStore(async () => db, files, (stage, e) => errors.push([stage, String(e)]));
  let ids = 0;
  const released = [];
  const queue = createScanQueue({
    run: runner.run,
    now: () => dev.clock,
    store,
    staleMs,
    adoptImage(scanId, uri) {
      const target = PENDING + pendingFilename(scanId);
      if (!dev.disk.has(uri)) throw new Error('ENOENT');
      dev.disk.set(target, dev.disk.get(uri));
      dev.disk.delete(uri);
      return target;
    },
    readImage: (uri) => dev.disk.get(uri) ?? null,
    onRelease(uri) {
      released.push(uri);
      dev.disk.delete(uri);
    },
    newScanId: () => `p-retry-${++ids}`,
  });

  const report = queue.restore(await store.load());
  await store.idle();
  const listed = [...dev.disk.keys()].filter((u) => u.startsWith(PENDING)).map((u) => u.slice(PENDING.length));
  const swept = orphanPendingFiles(listed, queue.snapshot(), files);
  for (const name of swept) dev.disk.delete(PENDING + name);

  const photoStore = createPhotoStore({
    ensureDir() {},
    copy(src, name) {
      if (!dev.disk.has(src)) throw new Error('ENOENT');
      dev.disk.set(PHOTOS + name, dev.disk.get(src));
    },
    delete(name) {
      dev.disk.delete(PHOTOS + name);
    },
    exists: (name) => dev.disk.has(PHOTOS + name),
    list: () => [...dev.disk.keys()].filter((u) => u.startsWith(PHOTOS)).map((u) => u.slice(PHOTOS.length)),
    uriFor: (name) => PHOTOS + name,
  });

  let itemIds = 0;
  /** Review & Save, wired exactly as `AddItemScreen` wires it. */
  async function save(scanId, name = 'Milk') {
    const scan = queue.get(scanId);
    await saveScannedItem(
      {
        retain: (id, uri) => photoStore.retain(id, uri),
        create: (input, fromScan) =>
          db.create(
            {
              id: `item-${scanId}-${++itemIds}`,
              ...input,
              dateType: input.dateType ?? 'unknown',
              source: input.source ?? 'manual',
              createdAt: new Date(dev.clock).toISOString(),
              updatedAt: new Date(dev.clock).toISOString(),
            },
            fromScan ? `save:${fromScan}` : `m-${itemIds}`,
            fromScan ? { consumesPendingScan: fromScan } : undefined,
          ),
        release: (id) => queue.remove(id),
      },
      { name, expiryDate: '2026-11-09', dateType: 'use_by', source: 'photo', scanId, photoUri: scan?.imageUri },
    );
    await store.idle();
  }

  return { db, drv, queue, store, runner, report, swept, released, errors, save, photoStore };
}

/** A shutter press: a resized JPEG lands in the cache and is handed over. */
function shoot(dev, app, scanId) {
  const cacheUri = `file:///cache/ImageManipulator/${scanId}.jpg`;
  dev.disk.set(cacheUri, `jpeg:${scanId}`);
  app.queue.add({
    scanId,
    imageBase64: `jpeg:${scanId}`,
    imageUri: cacheUri,
    capture: { shutterAt: dev.clock, captureMs: 10, resizeMs: 10 },
  });
  dev.clock += 1000;
}

/** Kill the process: nothing in memory survives, nothing on disk is lost. */
async function kill(app) {
  await app.store.idle();
  app.drv.close();
}

const rows = (app) => app.drv.db.prepare('SELECT * FROM pending_scans ORDER BY shutter_at').all();
const items = (app) => app.drv.db.prepare('SELECT * FROM items ORDER BY rowid').all();
const pendingOnDisk = (dev) => [...dev.disk.keys()].filter((u) => u.startsWith(PENDING)).sort();
const flush = () => new Promise((r) => setImmediate(r));

/* ---------------------------------------------------------------------------
 * Capture: durable from the shutter.
 * ------------------------------------------------------------------------ */

test('the shutter moves the photo out of the cache and persists the draft', async () => {
  const dev = device();
  const app = await boot(dev);
  shoot(dev, app, 'p-a');
  await app.store.idle();

  const [scan] = app.queue.snapshot();
  assert.equal(scan.imageUri, `${PENDING}pending-p-a.jpg`, 'durable, not the cache');
  assert.ok(!dev.disk.has('file:///cache/ImageManipulator/p-a.jpg'), 'moved, not copied');
  assert.equal(rows(app).length, 1);
  assert.equal(rows(app)[0].image_file, 'pending-p-a.jpg', 'stored as a filename, never a URI');
});

/* ---------------------------------------------------------------------------
 * Restart during processing.
 * ------------------------------------------------------------------------ */

test('killed while recognising: the draft comes back interrupted, never spinning', async () => {
  const dev = device();
  let app = await boot(dev);
  shoot(dev, app, 'p-a');
  assert.equal(app.queue.get('p-a').status, 'active');
  await kill(app);

  app = await boot(dev);
  const [scan] = app.queue.snapshot();
  assert.equal(scan.status, 'interrupted');
  assert.equal(scan.imageUri, `${PENDING}pending-p-a.jpg`, 'photo restored with it');
  assert.equal(app.runner.calls.length, 0, 'no request is assumed to be running, none is resent');
  assert.deepEqual(pendingSummary(scan), {
    title: "Didn't finish checking",
    note: 'Tap to try again',
    tappable: true,
  });
  assert.deepEqual(app.report, { restored: 1, interrupted: 1, expired: 0 });
  assert.equal(rows(app)[0].status, 'interrupted', 'the new state is persisted too');
});

test('a queued scan that never left the phone also comes back interrupted', async () => {
  const dev = device();
  let app = await boot(dev);
  for (const id of ['p-1', 'p-2', 'p-3', 'p-4']) shoot(dev, app, id); // cap is 3
  assert.equal(app.queue.get('p-4').status, 'queued');
  await kill(app);

  app = await boot(dev);
  assert.deepEqual(app.queue.snapshot().map((s) => s.status), Array(4).fill('interrupted'));
});

test('retry is explicit: it sends the same photo once, under a new id, in the same place', async () => {
  const dev = device();
  let app = await boot(dev);
  shoot(dev, app, 'p-a');
  shoot(dev, app, 'p-b');
  app.runner.calls[1].resolve(READY('Ham'));
  await flush();
  await kill(app);

  app = await boot(dev);
  assert.equal(app.queue.retry('p-a'), true);
  assert.equal(app.queue.retry('p-a'), false, 'the old id is gone; a second tap does nothing');
  assert.equal(app.runner.calls.length, 1);
  const { job } = app.runner.calls[0];
  assert.equal(job.scanId, 'p-retry-1');
  assert.equal(job.imageBase64, 'jpeg:p-a', 'the very image the first request carried');
  assert.deepEqual(app.queue.snapshot().map((s) => s.scanId), ['p-retry-1', 'p-b'], 'kept its place');

  app.runner.calls[0].resolve(READY('Milk'));
  await flush();
  await app.store.idle();
  assert.deepEqual(rows(app).map((r) => [r.scan_id, r.status]), [['p-retry-1', 'ready'], ['p-b', 'ready']]);
  assert.deepEqual(pendingOnDisk(dev), [`${PENDING}pending-p-a.jpg`, `${PENDING}pending-p-b.jpg`], 'one file each, none lost');
});

test('retry refuses a scan that is not interrupted, or whose photo is gone', async () => {
  const dev = device();
  let app = await boot(dev);
  shoot(dev, app, 'p-a');
  shoot(dev, app, 'p-b');
  assert.equal(app.queue.retry('p-a'), false, 'still active');
  await kill(app);

  dev.disk.delete(`${PENDING}pending-p-b.jpg`); // the OS or a cleaner took it
  app = await boot(dev);
  const b = app.queue.get('p-b');
  assert.equal(b.imageUri, undefined);
  assert.equal(app.queue.retry('p-b'), false);
  assert.deepEqual(pendingSummary(b), {
    title: "Couldn't read that one",
    note: 'Tap to type it in',
    tappable: true,
  }, 'without a photo it opens the editor instead');
});

/* ---------------------------------------------------------------------------
 * Restart after recognition, before Save.
 * ------------------------------------------------------------------------ */

test('a finished result is restored as it was, without asking the model again', async () => {
  const dev = device();
  let app = await boot(dev);
  shoot(dev, app, 'p-a');
  app.runner.calls[0].resolve(READY('Greek yoghurt', '2026-11-12'));
  await flush();
  const before = app.queue.get('p-a');
  await kill(app);

  app = await boot(dev);
  const after = app.queue.get('p-a');
  assert.deepEqual(after, before, 'status, prefill, trust, photo and timestamps');
  assert.equal(app.runner.calls.length, 0);
  assert.equal(items(app).length, 0, 'restored for review, never saved');
});

test('a failed scan is restored as failed and still opens for review', async () => {
  const dev = device();
  let app = await boot(dev);
  shoot(dev, app, 'p-a');
  app.runner.calls[0].resolve({ ok: false, prefill: { name: '', expiryDate: null, source: 'photo', dateType: 'unknown', needsNameCheck: true, needsDateCheck: true, notice: 'We could not reach the scanner.' } });
  await flush();
  await kill(app);

  app = await boot(dev);
  const scan = app.queue.get('p-a');
  assert.equal(scan.status, 'failed');
  assert.equal(scan.prefill.notice, 'We could not reach the scanner.');
  assert.equal(pendingSummary(scan).tappable, true);
});

/* ---------------------------------------------------------------------------
 * Multiple pending scans, and repeated restarts.
 * ------------------------------------------------------------------------ */

test('a Multiple Items session survives intact, in shutter order, every state kept', async () => {
  const dev = device();
  let app = await boot(dev);
  for (const id of ['p-1', 'p-2', 'p-3', 'p-4', 'p-5']) shoot(dev, app, id);
  app.runner.calls[2].resolve(READY('Three'));
  app.runner.calls[0].resolve(READY('One'));
  await flush(); // p-4, p-5 start
  app.runner.calls[3].resolve({ ok: false, prefill: { name: '', expiryDate: null, source: 'photo', dateType: 'unknown', needsNameCheck: true, needsDateCheck: true } });
  await flush();
  await kill(app);

  app = await boot(dev);
  assert.deepEqual(
    app.queue.snapshot().map((s) => `${s.scanId}:${s.status}`),
    ['p-1:ready', 'p-2:interrupted', 'p-3:ready', 'p-4:failed', 'p-5:interrupted'],
  );
  assert.equal(app.queue.counts().toReview, 5);
  assert.equal(app.queue.counts().checking, 0, 'nothing claims to be checking after a restart');
});

test('repeated restarts never duplicate a draft or leave a file behind', async () => {
  const dev = device();
  let app = await boot(dev);
  shoot(dev, app, 'p-a');
  shoot(dev, app, 'p-b');
  app.runner.calls[0].resolve(READY('A'));
  await flush();

  for (let i = 0; i < 5; i += 1) {
    await kill(app);
    app = await boot(dev);
    assert.equal(app.queue.snapshot().length, 2);
    assert.equal(rows(app).length, 2);
    assert.deepEqual(app.swept, []);
    assert.deepEqual(pendingOnDisk(dev), [`${PENDING}pending-p-a.jpg`, `${PENDING}pending-p-b.jpg`]);
  }
  assert.equal(app.report.interrupted, 0, 'already interrupted: not counted again');
  assert.equal(app.queue.restore(await app.store.load()).restored, 0, 'restore twice restores nothing twice');
  assert.equal(app.queue.snapshot().length, 2);
});

test('a scan photographed since launch is never overwritten by a restored row', async () => {
  const dev = device();
  const app = await boot(dev);
  shoot(dev, app, 'p-a');
  const report = app.queue.restore([{ scanId: 'p-a', status: 'ready', shutterAt: 0 }]);
  assert.equal(report.restored, 0); // already restored once at boot, and memory wins anyway
  assert.equal(app.queue.get('p-a').status, 'active');
});

/* ---------------------------------------------------------------------------
 * Duplicate and racing callbacks.
 * ------------------------------------------------------------------------ */

test('a result delivered twice settles once', async () => {
  const dev = device();
  const writes = [];
  const app = await boot(dev);
  shoot(dev, app, 'p-a');
  const call = app.runner.calls[0];
  call.resolve(READY('Milk'));
  call.resolve(READY('Something else')); // a promise settles once; the queue must too
  await flush();
  await app.store.idle();
  writes.push(...rows(app));
  assert.equal(app.queue.get('p-a').prefill.name, 'Milk');
  assert.equal(writes.length, 1);
});

test('the late answer to a superseded request cannot overwrite the retry', async () => {
  const dev = device();
  const app = await boot(dev, { staleMs: 50 });
  shoot(dev, app, 'p-a');
  const first = app.runner.calls[0];
  await new Promise((r) => setTimeout(r, 80)); // goes stale
  assert.equal(app.queue.get('p-a').status, 'interrupted');

  assert.equal(app.queue.retry('p-a'), true);
  first.resolve(READY('From the first request'));
  await flush();
  assert.equal(app.queue.get('p-a'), undefined, 'the old scan is not resurrected');
  assert.equal(app.queue.get('p-retry-1').status, 'active');

  app.runner.calls[1].resolve(READY('From the retry'));
  await flush();
  await app.store.idle();
  assert.equal(app.queue.snapshot().length, 1);
  assert.equal(app.queue.get('p-retry-1').prefill.name, 'From the retry');
  assert.equal(rows(app).length, 1);
});

test('saving the same draft twice — a double tap, or after a crash — is one item', async () => {
  const dev = device();
  let app = await boot(dev);
  shoot(dev, app, 'p-a');
  app.runner.calls[0].resolve(READY('Milk'));
  await flush();

  await Promise.all([app.save('p-a'), app.save('p-a')]);
  assert.equal(items(app).length, 1);
  await app.save('p-a');
  assert.equal(items(app).length, 1, 'a replay returns the item already created');

  await kill(app);
  app = await boot(dev);
  assert.equal(items(app).length, 1);
  assert.equal(app.queue.snapshot().length, 0, 'the draft is gone with it');
});

/* ---------------------------------------------------------------------------
 * Stale scans.
 * ------------------------------------------------------------------------ */

test('a request that never answers stops spinning, frees its slot, and can be retried', async () => {
  const dev = device();
  const app = await boot(dev, { staleMs: 50 });
  for (const id of ['p-1', 'p-2', 'p-3', 'p-4']) shoot(dev, app, id);
  assert.equal(app.queue.get('p-4').status, 'queued', 'behind three hung requests');

  await new Promise((r) => setTimeout(r, 80));
  assert.equal(app.queue.get('p-1').status, 'interrupted');
  assert.equal(app.queue.get('p-4').status, 'active', 'the hung requests no longer hold the queue');
  assert.equal(pendingSummary(app.queue.get('p-1')).title, "Didn't finish checking");
  await app.store.idle();
  assert.equal(rows(app).find((r) => r.scan_id === 'p-1').status, 'interrupted');
});

test('a stale request that answers after all is kept, not thrown away', async () => {
  const dev = device();
  const app = await boot(dev, { staleMs: 50 });
  shoot(dev, app, 'p-a');
  await new Promise((r) => setTimeout(r, 80));
  app.runner.calls[0].resolve(READY('Late but right'));
  await flush();
  assert.equal(app.queue.get('p-a').status, 'ready');
  assert.equal(app.queue.get('p-a').prefill.name, 'Late but right');
  assert.equal(app.runner.calls.length, 1, 'no second request was needed');
});

test('the shipped watchdog is longer than the client timeout it backs up', () => {
  assert.ok(STALE_MS > 30_000);
});

/* ---------------------------------------------------------------------------
 * Retake, Discard, and photo ownership on Save.
 * ------------------------------------------------------------------------ */

test('retake replaces the draft durably and releases only the superseded photo', async () => {
  const dev = device();
  let app = await boot(dev);
  shoot(dev, app, 'p-a');
  shoot(dev, app, 'p-b');
  app.runner.calls[0].resolve(READY('Wrong'));
  await flush();

  const cacheUri = 'file:///cache/ImageManipulator/p-a2.jpg';
  dev.disk.set(cacheUri, 'jpeg:p-a2');
  app.queue.replace('p-a', { scanId: 'p-a2', imageBase64: 'jpeg:p-a2', imageUri: cacheUri, capture: { shutterAt: dev.clock, captureMs: 1, resizeMs: 1 } });
  await app.store.idle();
  await flush();

  assert.deepEqual(rows(app).map((r) => r.scan_id), ['p-a2', 'p-b'], 'one draft in, one out, same place');
  assert.deepEqual(pendingOnDisk(dev), [`${PENDING}pending-p-a2.jpg`, `${PENDING}pending-p-b.jpg`]);
  await kill(app);
  app = await boot(dev);
  assert.deepEqual(app.queue.snapshot().map((s) => s.scanId), ['p-a2', 'p-b']);
});

test('discard deletes the draft row and its photo, and nothing else', async () => {
  const dev = device();
  let app = await boot(dev);
  shoot(dev, app, 'p-a');
  shoot(dev, app, 'p-b');
  app.queue.remove('p-a');
  await app.store.idle();
  await flush();
  assert.deepEqual(rows(app).map((r) => r.scan_id), ['p-b']);
  assert.deepEqual(pendingOnDisk(dev), [`${PENDING}pending-p-b.jpg`]);

  await kill(app);
  app = await boot(dev);
  assert.deepEqual(app.queue.snapshot().map((s) => s.scanId), ['p-b'], 'a discarded draft stays discarded');
});

test('Save hands the photo to the item: a durable copy kept, the draft copy released', async () => {
  const dev = device();
  let app = await boot(dev);
  shoot(dev, app, 'p-a');
  app.runner.calls[0].resolve(READY('Milk'));
  await flush();

  await app.save('p-a');
  await flush();
  const [item] = items(app);
  assert.equal(item.photo, 'scan-p-a.jpg');
  assert.equal(dev.disk.get(`${PHOTOS}scan-p-a.jpg`), 'jpeg:p-a', 'the saved item owns its own copy');
  assert.deepEqual(pendingOnDisk(dev), [], 'the draft copy is gone');
  assert.equal(rows(app).length, 0);

  // And no later sweep of the pending directory can touch the item's photo.
  await kill(app);
  app = await boot(dev);
  assert.ok(dev.disk.has(`${PHOTOS}scan-p-a.jpg`));
  assert.equal(app.photoStore.sweep([item.photo]), 0);
});

test('killed between the item write and the clean-up: no draft, no duplicate, file collected', async () => {
  const dev = device();
  let app = await boot(dev);
  shoot(dev, app, 'p-a');
  app.runner.calls[0].resolve(READY('Milk'));
  await flush();

  // The write lands (and retires the row in the same transaction); the process
  // dies before the screen's release step runs.
  await app.db.create(
    { id: 'item-1', name: 'Milk', expiryDate: '2026-11-09', source: 'photo', createdAt: 'x', updatedAt: 'x' },
    'save:p-a',
    { consumesPendingScan: 'p-a' },
  );
  await kill(app);

  app = await boot(dev);
  assert.equal(app.queue.snapshot().length, 0, 'the draft does not come back to be saved twice');
  assert.equal(items(app).length, 1);
  assert.deepEqual(app.swept, ['pending-p-a.jpg'], 'its leftover file is swept at start-up');
  assert.deepEqual(pendingOnDisk(dev), []);
});

/* ---------------------------------------------------------------------------
 * Interrupted writes and rollback.
 * ------------------------------------------------------------------------ */

test('a failed item write leaves the draft, its row and its photo exactly as they were', async () => {
  const dev = device();
  const driver = createNodeDriver(dev.path);
  const app = await boot(dev, { driver });
  shoot(dev, app, 'p-a');
  app.runner.calls[0].resolve(READY('Milk'));
  await flush();
  await app.store.idle();

  driver.failOn((sql) => sql.startsWith('INSERT INTO sync_outbox'));
  await assert.rejects(app.save('p-a'));
  assert.equal(items(app).length, 0, 'no item');
  assert.equal(rows(app).length, 1, 'the draft row was not consumed: the delete rolled back');
  assert.equal(app.queue.get('p-a').status, 'ready', 'still there to save again');
  assert.ok(dev.disk.has(`${PENDING}pending-p-a.jpg`));

  await app.save('p-a');
  assert.equal(items(app).length, 1, 'and the retry succeeds');
});

test('a retake whose write fails keeps the original photo, so a restart restores it whole', async () => {
  const dev = device();
  const driver = createNodeDriver(dev.path);
  let app = await boot(dev, { driver });
  shoot(dev, app, 'p-a');
  app.runner.calls[0].resolve(READY('Original'));
  await flush();
  await app.store.idle();

  driver.failOn((sql) => sql.startsWith('INSERT INTO pending_scans'));
  const cacheUri = 'file:///cache/ImageManipulator/p-a2.jpg';
  dev.disk.set(cacheUri, 'jpeg:p-a2');
  app.queue.replace('p-a', { scanId: 'p-a2', imageBase64: 'x', imageUri: cacheUri, capture: { shutterAt: 1, captureMs: 1, resizeMs: 1 } });
  await app.store.idle();
  await flush();
  assert.deepEqual(rows(app).map((r) => r.scan_id), ['p-a'], 'the replace rolled back as a unit');
  assert.ok(dev.disk.has(`${PENDING}pending-p-a.jpg`), 'its photo was not released');
  assert.equal(app.errors.length, 1, 'and the failure was reported');

  await kill(app);
  app = await boot(dev);
  const restored = app.queue.get('p-a');
  assert.equal(restored.prefill.name, 'Original');
  assert.equal(restored.imageUri, `${PENDING}pending-p-a.jpg`);
  assert.deepEqual(app.swept, ['pending-p-a2.jpg'], 'the unpersisted retake photo is collected');
});

test('a draft whose save is cut off mid-transaction is still a draft after restart', async () => {
  const dev = device();
  const driver = createNodeDriver(dev.path);
  let app = await boot(dev, { driver });
  shoot(dev, app, 'p-a');
  app.runner.calls[0].resolve(READY('Milk'));
  await flush();
  await app.store.idle();

  // Dies inside the item transaction: ROLLBACK never runs.
  driver.failOn((sql) => sql.startsWith('INSERT INTO item_events') || sql === 'ROLLBACK', { sticky: true });
  await assert.rejects(app.save('p-a'));
  driver.close();

  app = await boot(dev);
  assert.equal(items(app).length, 0);
  assert.equal(app.queue.get('p-a').status, 'ready');
  assert.ok(dev.disk.has(`${PENDING}pending-p-a.jpg`));
});

/* ---------------------------------------------------------------------------
 * Accumulation.
 * ------------------------------------------------------------------------ */

test('drafts older than the retention limit are dropped at start-up, photos with them', async () => {
  const dev = device();
  let app = await boot(dev);
  shoot(dev, app, 'p-old');
  await kill(app);

  dev.clock += MAX_DRAFT_AGE_MS / 2;
  app = await boot(dev);
  shoot(dev, app, 'p-new');
  await kill(app);

  dev.clock += MAX_DRAFT_AGE_MS / 2 + 1;
  app = await boot(dev);
  await app.store.idle();
  await flush();
  assert.deepEqual(app.report, { restored: 1, interrupted: 1, expired: 1 });
  assert.deepEqual(app.queue.snapshot().map((s) => s.scanId), ['p-new']);
  assert.deepEqual(rows(app).map((r) => r.scan_id), ['p-new']);
  assert.deepEqual(pendingOnDisk(dev), [`${PENDING}pending-p-new.jpg`]);
});

test('the sweep only ever deletes our own unreferenced files', () => {
  const files = pendingFiles(new Map([[`${PENDING}pending-p-a.jpg`, 'x']]));
  const scans = [{ scanId: 'p-a', status: 'ready', shutterAt: 0, imageUri: `${PENDING}pending-p-a.jpg` }];
  assert.deepEqual(
    orphanPendingFiles(['pending-p-a.jpg', 'pending-p-b.jpg', 'notes.txt', 'scan-p-c.jpg', 'pending-../x.jpg'], scans, files),
    ['pending-p-b.jpg'],
  );
});

/* ---------------------------------------------------------------------------
 * The row mapping.
 * ------------------------------------------------------------------------ */

test('rows round-trip losslessly, and a damaged row costs only what is damaged', () => {
  const disk = new Map([[`${PENDING}pending-p-a.jpg`, 'x']]);
  const files = pendingFiles(disk);
  const scan = { scanId: 'p-a', status: 'ready', shutterAt: 5, settledAt: 9, imageUri: `${PENDING}pending-p-a.jpg`, prefill: READY('Milk').prefill, trust: READY('Milk').trust };
  assert.deepEqual(rowToScan(scanToRow(scan, files), files), scan);

  const damaged = { ...scanToRow(scan, files), prefill: '{not json' };
  const restored = rowToScan(damaged, files);
  assert.equal(restored.prefill, undefined);
  assert.equal(restored.imageUri, scan.imageUri, 'the photo survives a bad result');
  assert.equal(pendingSummary(restored).title, "Couldn't read that one");

  assert.equal(rowToScan({ ...damaged, status: 'exploded' }, files), null);
  assert.equal(scanToRow({ ...scan, imageUri: 'file:///cache/x.jpg' }, files).image_file, null, 'cache URIs are never persisted');
});

test('no code path from a restored draft saves an item without review', async () => {
  const dev = device();
  let app = await boot(dev);
  for (const id of ['p-1', 'p-2', 'p-3']) shoot(dev, app, id);
  for (const c of app.runner.calls) c.resolve(READY('Auto?'));
  await flush();
  for (let i = 0; i < 3; i += 1) {
    await kill(app);
    app = await boot(dev);
  }
  assert.equal(items(app).length, 0);
  assert.equal(app.queue.snapshot().every((s) => s.status === 'ready'), true);
});
