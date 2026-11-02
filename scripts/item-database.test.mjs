/**
 * The SQLite item database on its own: schema migration, transactions,
 * concurrency, idempotency, rollback and persistence across a restart.
 *
 * Loaded directly under Node's type stripping (`itemDatabase.ts` has no value
 * imports outside `db/`) and run against **real SQLite** via `node:sqlite` —
 * so constraint enforcement, BEGIN/COMMIT/ROLLBACK and what survives closing a
 * connection are the engine's behaviour, not a fake's. Failures are injected
 * with `driver.failOn(...)`, which throws before the matching statement runs:
 * how a full disk or a killed process looks to the code above it.
 *
 * Legacy AsyncStorage import is in `storage-migration.test.mjs`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createNodeDriver } from './support/fakes.mjs';
import { createItemDatabase } from '../src/domain/items/db/itemDatabase.ts';
import { SCHEMA_VERSION } from '../src/domain/items/db/schema.ts';

let clock = 0;
const now = () => new Date(Date.UTC(2026, 10, 1, 0, 0, clock++)).toISOString();

function item(id, extra = {}) {
  return {
    id,
    name: `Item ${id}`,
    expiryDate: '2026-11-10',
    dateType: 'use_by',
    source: 'manual',
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    ...extra,
  };
}

function open(driver = createNodeDriver()) {
  return { driver, db: createItemDatabase({ driver, now }) };
}

function count(driver, table) {
  return driver.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
}

function tempDbPath() {
  const dir = mkdtempSync(join(tmpdir(), 'useby-db-'));
  return { path: join(dir, 'useby.db'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/* ---------------------------------------------------------------------------
 * Schema migration.
 * ------------------------------------------------------------------------ */

test('a fresh database is created at the current schema version', async () => {
  const { driver, db } = open();
  await db.ready();
  assert.equal(driver.db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
  const tables = driver.db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((t) => t.name);
  for (const t of ['items', 'item_events', 'mutations', 'sync_outbox', 'meta', 'legacy_snapshot']) {
    assert.ok(tables.includes(t), `${t} exists`);
  }
});

test('ready() is idempotent, including when called concurrently', async () => {
  const { driver, db } = open();
  await Promise.all([db.ready(), db.ready(), db.listActive(), db.ready()]);
  await db.ready();
  const creates = driver.log.filter((s) => s.includes('CREATE TABLE items')).length;
  assert.equal(creates, 1, 'the migration ran once');
});

test('an interrupted schema migration leaves nothing behind and is retried whole', async () => {
  const driver = createNodeDriver();
  driver.failOn((sql) => sql.startsWith('PRAGMA user_version ='));
  const { db } = open(driver);

  await assert.rejects(db.ready(), /injected failure/);
  assert.equal(driver.db.prepare('PRAGMA user_version').get().user_version, 0);
  assert.equal(
    driver.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'").get().n,
    0,
    'the CREATE TABLEs rolled back with the version bump',
  );

  // Next call starts again from scratch, and succeeds.
  await db.create(item('a'), 'm-a');
  assert.equal((await db.listActive()).length, 1);
});

test('a database from a newer build is refused, not written to', async () => {
  const driver = createNodeDriver();
  driver.db.exec('CREATE TABLE future (x); PRAGMA user_version = 99;');
  const { db } = open(driver);
  await assert.rejects(db.ready(), /schema 99/);
  await assert.rejects(db.create(item('a'), 'm-a'), /schema 99/);
  assert.equal(driver.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'items'").get().n, 0);
});

/* ---------------------------------------------------------------------------
 * Concurrency — the gap this slice exists to close.
 * ------------------------------------------------------------------------ */

test('fifty overlapping creates all land', async () => {
  const { db } = open();
  await Promise.all(Array.from({ length: 50 }, (_, i) => db.create(item(`i${i}`), `m${i}`)));
  assert.equal((await db.listActive()).length, 50);
});

test('overlapping updates to one item each see the previous one\'s result', async () => {
  const { db } = open();
  await db.create(item('a', { name: '' }), 'm-create');

  // Each change appends to the name it is handed. If any update read a stale
  // copy, a letter would be lost.
  await Promise.all(
    'abcdefghij'.split('').map((letter, n) =>
      db.update('a', (cur) => ({ ...cur, name: cur.name + letter }), `m-${n}`),
    ),
  );
  assert.equal((await db.getActive('a')).name, 'abcdefghij');
});

test('a removal overlapping an edit: the edit cannot resurrect the item', async () => {
  const { db } = open();
  await db.create(item('a'), 'm-create');
  const [removed, edited] = await Promise.all([
    db.remove('a', 'used', 'm-remove'),
    db.update('a', (cur) => ({ ...cur, name: 'Late edit' }), 'm-edit'),
  ]);
  assert.equal(removed.id, 'a');
  assert.equal(edited.item, null, 'the edit found nothing on the list to change');
  assert.deepEqual(await db.listActive(), []);
});

test('reads never see another operation half-done', async () => {
  const { driver, db } = open();
  await db.ready();
  const seen = [];
  const writes = Array.from({ length: 20 }, (_, i) => db.create(item(`i${i}`), `m${i}`));
  const reads = Array.from({ length: 20 }, () =>
    db.listActive().then((items) => {
      // Every listed item must have its mutation recorded: they commit together.
      const mutations = count(driver, 'mutations');
      seen.push([items.length, mutations]);
    }),
  );
  await Promise.all([...writes, ...reads]);
  for (const [items, mutations] of seen) assert.ok(items <= mutations);
});

/* ---------------------------------------------------------------------------
 * Atomicity and rollback.
 * ------------------------------------------------------------------------ */

for (const stage of ['INSERT INTO mutations', 'INSERT INTO item_events', 'INSERT INTO sync_outbox', 'COMMIT']) {
  test(`a create failing at ${stage} leaves no trace, and the database keeps working`, async () => {
    const { driver, db } = open();
    await db.ready();
    driver.failOn((sql) => sql.startsWith(stage));

    await assert.rejects(db.create(item('a'), 'm-a'), /injected failure/);
    for (const t of ['items', 'mutations', 'item_events', 'sync_outbox']) {
      assert.equal(count(driver, t), 0, `${t} empty`);
    }

    await db.create(item('a'), 'm-a');
    assert.equal((await db.listActive()).length, 1, 'the same call succeeds on retry');
  });
}

test('a failed edit leaves the item exactly as it was', async () => {
  const { driver, db } = open();
  await db.create(item('a'), 'm-create');
  const before = driver.db.prepare('SELECT * FROM items').get();

  driver.failOn((sql) => sql.startsWith('INSERT INTO sync_outbox'));
  await assert.rejects(db.update('a', (c) => ({ ...c, name: 'X' }), 'm-edit'));
  assert.deepEqual(driver.db.prepare('SELECT * FROM items').get(), before);
  assert.equal(count(driver, 'mutations'), 1);
});

test('a failed Used leaves the item on the list with its photo', async () => {
  const { driver, db } = open();
  await db.create(item('a', { photo: 'scan-a.jpg' }), 'm-create');

  driver.failOn((sql) => sql.startsWith('INSERT INTO item_events'));
  await assert.rejects(db.remove('a', 'used', 'm-used'));
  const [still] = await db.listActive();
  assert.equal(still.photo, 'scan-a.jpg');
  assert.deepEqual(await db.referencedPhotos(), ['scan-a.jpg']);
});

test('a change function that throws aborts its own transaction only', async () => {
  const { db } = open();
  await db.create(item('a'), 'm-a');
  await db.create(item('b'), 'm-b');
  const results = await Promise.allSettled([
    db.update('a', () => {
      throw new Error('boom');
    }, 'm-1'),
    db.update('b', (c) => ({ ...c, name: 'B2' }), 'm-2'),
  ]);
  assert.equal(results[0].status, 'rejected');
  assert.equal((await db.getActive('a')).name, 'Item a');
  assert.equal((await db.getActive('b')).name, 'B2');
});

test('an update cannot change an item\'s id', async () => {
  const { db } = open();
  await db.create(item('a'), 'm-a');
  await assert.rejects(db.update('a', (c) => ({ ...c, id: 'b' }), 'm-1'), /cannot change an item id/);
  assert.ok(await db.getActive('a'));
});

/* ---------------------------------------------------------------------------
 * Idempotency: a mutation applied twice is applied once.
 * ------------------------------------------------------------------------ */

test('replaying a create, an edit or a removal changes nothing the second time', async () => {
  const { driver, db } = open();
  await db.create(item('a'), 'm-create');
  await db.create(item('a'), 'm-create');
  assert.equal(count(driver, 'items'), 1);

  await db.update('a', (c) => ({ ...c, name: c.name + '!' }), 'm-edit');
  await db.update('a', (c) => ({ ...c, name: c.name + '!' }), 'm-edit');
  assert.equal((await db.getActive('a')).name, 'Item a!');

  assert.ok(await db.remove('a', 'used', 'm-used'));
  assert.equal(await db.remove('a', 'used', 'm-used'), null);
  assert.equal(count(driver, 'mutations'), 3);
  assert.equal(count(driver, 'sync_outbox'), 3);
  assert.equal(count(driver, 'item_events'), 3);
});

test('an update that changes nothing records nothing', async () => {
  const { driver, db } = open();
  await db.create(item('a'), 'm-create');
  const result = await db.update('a', () => null, 'm-noop');
  assert.equal(result.changed, false);
  assert.equal(result.item.id, 'a');
  assert.equal(count(driver, 'mutations'), 1);
});

/* ---------------------------------------------------------------------------
 * Persistence across a restart, against a real database file.
 * ------------------------------------------------------------------------ */

test('items, statuses and history survive closing and reopening the file', async () => {
  const { path, cleanup } = tempDbPath();
  try {
    let driver = createNodeDriver(path);
    let db = createItemDatabase({ driver, now });
    await db.create(item('keep', { photo: 'scan-keep.jpg', dateUserSet: true }), 'm1');
    await db.create(item('eaten'), 'm2');
    await db.create(item('oops'), 'm3');
    await db.update('keep', (c) => ({ ...c, name: 'Kept' }), 'm4');
    await db.remove('eaten', 'used', 'm5');
    await db.remove('oops', 'deleted', 'm6');
    driver.close();

    driver = createNodeDriver(path);
    db = createItemDatabase({ driver, now });
    const active = await db.listActive();
    assert.deepEqual(active, [
      item('keep', { name: 'Kept', photo: 'scan-keep.jpg', dateUserSet: true }),
    ]);
    const statuses = driver.db.prepare('SELECT id, status FROM items ORDER BY rowid').all();
    assert.deepEqual(statuses.map((r) => `${r.id}:${r.status}`), ['keep:active', 'eaten:used', 'oops:deleted']);
    assert.equal(count(driver, 'sync_outbox'), 6);

    // And replays from before the restart are still recognised.
    await db.update('keep', (c) => ({ ...c, name: 'Again' }), 'm4');
    assert.equal((await db.getActive('keep')).name, 'Kept');
    driver.close();
  } finally {
    cleanup();
  }
});

test('a write cut off mid-transaction by the process dying is gone after restart', async () => {
  const { path, cleanup } = tempDbPath();
  try {
    let driver = createNodeDriver(path);
    let db = createItemDatabase({ driver, now });
    await db.create(item('before'), 'm1');

    // The process "dies" after the item row is written but before COMMIT: the
    // outbox insert throws and ROLLBACK never gets to run either.
    driver.failOn((sql) => sql.startsWith('INSERT INTO sync_outbox') || sql === 'ROLLBACK', {
      sticky: true,
    });
    await assert.rejects(db.create(item('torn'), 'm2'));
    driver.close(); // an open transaction is discarded with the connection

    driver = createNodeDriver(path);
    db = createItemDatabase({ driver, now });
    assert.deepEqual((await db.listActive()).map((i) => i.id), ['before']);
    assert.equal(count(driver, 'mutations'), 1);
    driver.close();
  } finally {
    cleanup();
  }
});

/* ---------------------------------------------------------------------------
 * Schema v2 (pending scans) on top of a v1 database from the previous build.
 * ------------------------------------------------------------------------ */

test('a v1 database upgrades to v2 in place, items and history untouched', async () => {
  const { MIGRATIONS } = await import('../src/domain/items/db/schema.ts');
  const driver = createNodeDriver();
  // Exactly what the previous build left: schema v1 and some data.
  driver.db.exec(MIGRATIONS[0].sql);
  driver.db.exec('PRAGMA user_version = 1');
  driver.db
    .prepare("INSERT INTO items (id, name, expiry_date, source, status) VALUES ('old', 'Jam', '2026-12-01', 'manual', 'active')")
    .run();
  const before = driver.db.prepare('SELECT * FROM items').all();

  const { db } = open(driver);
  await db.ready();
  assert.equal(driver.db.prepare('PRAGMA user_version').get().user_version, 2);
  assert.deepEqual(driver.db.prepare('SELECT * FROM items').all(), before);
  assert.deepEqual(await db.listPendingScans(), []);
});

test('an interrupted v1→v2 upgrade rolls back to v1 and retries', async () => {
  const { MIGRATIONS } = await import('../src/domain/items/db/schema.ts');
  const driver = createNodeDriver();
  driver.db.exec(MIGRATIONS[0].sql);
  driver.db.exec('PRAGMA user_version = 1');
  driver.failOn((sql) => sql === 'PRAGMA user_version = 2');

  const { db } = open(driver);
  await assert.rejects(db.ready());
  assert.equal(driver.db.prepare('PRAGMA user_version').get().user_version, 1);
  assert.equal(
    driver.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'pending_scans'").get().n,
    0,
  );
  await db.ready();
  assert.equal(driver.db.prepare('PRAGMA user_version').get().user_version, 2);
});

test('creating an item from a draft retires the draft row in the same transaction', async () => {
  const { driver, db } = open();
  await db.putPendingScan({ scan_id: 'p-a', status: 'ready', shutter_at: 1, settled_at: 2, image_file: 'pending-p-a.jpg', prefill: '{}', trust: null });
  await db.putPendingScan({ scan_id: 'p-b', status: 'ready', shutter_at: 3, settled_at: 4, image_file: null, prefill: null, trust: null });

  const first = await db.create(item('one'), 'save:p-a', { consumesPendingScan: 'p-a' });
  const again = await db.create(item('two'), 'save:p-a', { consumesPendingScan: 'p-a' });
  assert.equal(again.id, first.id, 'a replay answers with the item the first save created');
  assert.equal(count(driver, 'items'), 1);
  assert.deepEqual((await db.listPendingScans()).map((r) => r.scan_id), ['p-b'], 'only its own draft');
});

test('pending-scan writes overwrite in place and replace atomically', async () => {
  const { driver, db } = open();
  const row = { scan_id: 'p-a', status: 'queued', shutter_at: 1, settled_at: null, image_file: 'pending-p-a.jpg', prefill: null, trust: null };
  await db.putPendingScan(row);
  await db.putPendingScan({ ...row, status: 'ready', settled_at: 5, prefill: '{"name":"Milk"}' });
  assert.deepEqual(
    (await db.listPendingScans()).map((r) => ({ ...r })),
    [{ ...row, status: 'ready', settled_at: 5, prefill: '{"name":"Milk"}' }],
  );

  driver.failOn((sql) => sql.startsWith('INSERT INTO pending_scans'));
  await assert.rejects(db.replacePendingScan('p-a', { ...row, scan_id: 'p-b' }));
  assert.deepEqual((await db.listPendingScans()).map((r) => r.scan_id), ['p-a'], 'delete rolled back with the insert');

  await db.replacePendingScan('p-a', { ...row, scan_id: 'p-b' });
  assert.deepEqual((await db.listPendingScans()).map((r) => r.scan_id), ['p-b']);
  await db.deletePendingScan('p-b');
  await db.deletePendingScan('p-b');
  assert.deepEqual(await db.listPendingScans(), []);
});
