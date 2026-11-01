/**
 * The one-time import of the AsyncStorage item envelope into SQLite.
 *
 * What must hold, and what each section below pins:
 *
 * - **Fidelity.** Every item the old reader showed comes back field for field:
 *   id, name, date, date type, photo, source, `dateUserSet`, timestamps, and
 *   any field the schema has no column for. Records from every envelope
 *   version (1–4) are covered.
 * - **Nothing is destroyed.** The AsyncStorage key is never written or removed,
 *   and the raw envelope is snapshotted into SQLite whatever its state.
 * - **All or nothing.** An interruption at any step leaves no partial import
 *   and no completion marker, so the next start-up does the whole thing again.
 * - **Once.** A second start-up, a concurrent one, or a lost marker never
 *   duplicates or overwrites anything.
 * - **Then the app works on it**: edit, Used, Delete and photo retention on
 *   imported items, through the real service (last section).
 *
 * Database-level cases drive `itemDatabase.ts` directly against real SQLite
 * (`node:sqlite`). Service-level cases go through `service.ts` and
 * `storage.ts` via `support/app-loader.mjs`, so the `expo-sqlite` adapter is
 * exercised too.
 */
import { test, describe, before, mock } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createNodeDriver, createMemoryAsyncStorage, install } from './support/fakes.mjs';

register('./support/app-loader.mjs', import.meta.url);

const { createItemDatabase } = await import('../src/domain/items/db/itemDatabase.ts');
const { LEGACY_ITEMS_KEY } = await import('../src/domain/items/db/legacy.ts');

const KEY = '@useby_v1_items';
const T = '2026-10-01T09:00:00.000Z';

/** One record from each envelope era, plus the awkward cases. */
const LEGACY_ITEMS = [
  // v1: before date types, photos and dateUserSet.
  { id: 'mfk2j8x1abc', name: 'Jam', expiryDate: '2026-12-01', source: 'manual', createdAt: T, updatedAt: T },
  // v2: date type recorded.
  { id: 'mfk2j8x2def', name: 'Milk', expiryDate: '2026-11-03', dateType: 'use_by', source: 'photo', createdAt: T, updatedAt: T },
  // v3: retained photo.
  { id: 'mfk2j8x3ghi', name: 'Cheddar', expiryDate: '2026-11-20', dateType: 'best_before', photo: 'scan-p-cheddar.jpg', source: 'photo', createdAt: T, updatedAt: T },
  // v4: date corrected by a person — the observation stays beside the flag.
  { id: 'mfk2j8x4jkl', name: 'Ham', expiryDate: '2026-11-05', dateType: 'best_before', dateUserSet: true, photo: 'scan-p-ham.jpg', source: 'photo', createdAt: T, updatedAt: '2026-10-02T10:00:00.000Z' },
  // Odd but valid to the old reader: missing timestamps and source, a
  // dateType this build does not know, an explicit false, an unknown field.
  { id: 'odd', name: 'Mystery', expiryDate: '2026-11-09', dateType: 'expiry', dateUserSet: false, note: { kept: [1, 2] } },
];

function envelope(items = LEGACY_ITEMS, version = 4) {
  return JSON.stringify({ version, items });
}

let clock = 0;
const now = () => new Date(Date.UTC(2026, 10, 1, 0, 0, clock++)).toISOString();

function setup({ raw = envelope(), driver = createNodeDriver(), kv = createMemoryAsyncStorage() } = {}) {
  if (raw !== null) kv.data.set(KEY, raw);
  const reports = [];
  const db = createItemDatabase({
    driver,
    legacy: kv,
    now,
    onLegacyImport: (r, fresh) => reports.push({ ...r, fresh }),
  });
  return { db, driver, kv, reports };
}

function count(driver, table) {
  return driver.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
}

function marker(driver) {
  const row = driver.db.prepare("SELECT value FROM meta WHERE key = 'legacy_import'").get();
  return row ? JSON.parse(row.value) : null;
}

/* ---------------------------------------------------------------------------
 * Fidelity.
 * ------------------------------------------------------------------------ */

test('the key is the one every AsyncStorage-era build wrote', () => {
  assert.equal(LEGACY_ITEMS_KEY, KEY);
});

test('every legacy item comes back exactly as stored, in stored order', async () => {
  const { db } = setup();
  assert.deepEqual(await db.listActive(), LEGACY_ITEMS);
});

test('ids, photos and corrections survive individually', async () => {
  const { db } = setup();
  const ham = await db.getActive('mfk2j8x4jkl');
  assert.equal(ham.photo, 'scan-p-ham.jpg');
  assert.equal(ham.dateUserSet, true);
  assert.equal(ham.dateType, 'best_before', 'the observation is not rewritten');
  assert.deepEqual(await db.referencedPhotos(), ['scan-p-cheddar.jpg', 'scan-p-ham.jpg']);

  const jam = await db.getActive('mfk2j8x1abc');
  assert.equal('dateType' in jam, false, 'absence is carried across, not invented');
  assert.equal('photo' in jam, false);
  assert.equal('dateUserSet' in jam, false);
});

test('the import is recorded as history and queued for a future sync', async () => {
  const { db, driver, reports } = setup();
  await db.ready();
  assert.equal(count(driver, 'mutations'), LEGACY_ITEMS.length);
  assert.equal(count(driver, 'sync_outbox'), LEGACY_ITEMS.length);
  const kinds = driver.db.prepare('SELECT DISTINCT kind FROM item_events').all().map((r) => r.kind);
  assert.deepEqual(kinds, ['imported']);
  assert.equal(reports.length, 1);
  assert.equal(reports[0].outcome, 'imported');
  assert.equal(reports[0].imported, LEGACY_ITEMS.length);
  assert.equal(reports[0].envelopeVersion, 4);
  assert.equal(reports[0].fresh, true);
});

/* ---------------------------------------------------------------------------
 * Nothing is destroyed.
 * ------------------------------------------------------------------------ */

test('the AsyncStorage key is left byte-for-byte untouched, and snapshotted', async () => {
  const { db, kv, driver } = setup();
  const raw = kv.data.get(KEY);
  await db.ready();
  assert.equal(kv.data.get(KEY), raw);
  assert.equal(kv.writes.length, 0, 'the importer never writes AsyncStorage');
  assert.equal(driver.db.prepare('SELECT raw FROM legacy_snapshot WHERE key = ?').get(KEY).raw, raw);
});

test('elements the old reader skipped are skipped, counted and preserved', async () => {
  const raw = JSON.stringify({
    version: 4,
    items: [
      { id: 'ok', name: 'Milk', expiryDate: '2026-11-03' },
      { id: 'bad', name: 'No date' },
      null,
      'junk',
      { id: 'ok', name: 'Milk (dup)', expiryDate: '2026-11-04' },
    ],
  });
  const { db, driver } = setup({ raw });
  assert.deepEqual((await db.listActive()).map((i) => i.name), ['Milk']);
  const m = marker(driver);
  assert.equal(m.imported, 1);
  assert.equal(m.invalid, 3);
  assert.equal(m.duplicates, 1);
  assert.equal(driver.db.prepare('SELECT raw FROM legacy_snapshot').get().raw, raw);
});

test('an unreadable envelope imports nothing, keeps the raw value, and the app carries on', async () => {
  const { db, driver, kv } = setup({ raw: '{not json' });
  assert.deepEqual(await db.listActive(), [], 'matches what the old reader showed');
  assert.equal(marker(driver).outcome, 'unreadable');
  assert.equal(driver.db.prepare('SELECT raw FROM legacy_snapshot').get().raw, '{not json');
  assert.equal(kv.data.get(KEY), '{not json');
  await db.create({ id: 'new', name: 'Bread', expiryDate: '2026-11-02', source: 'manual', createdAt: T, updatedAt: T }, 'm');
  assert.equal((await db.listActive()).length, 1);
});

test('an envelope with no items array is unreadable, not a crash', async () => {
  const { db, driver } = setup({ raw: JSON.stringify({ version: 4, items: 'nope' }) });
  assert.deepEqual(await db.listActive(), []);
  assert.equal(marker(driver).outcome, 'unreadable');
});

test('no key at all is a fresh install: nothing imported, nothing snapshotted', async () => {
  const { db, driver } = setup({ raw: null });
  assert.deepEqual(await db.listActive(), []);
  assert.equal(marker(driver).outcome, 'absent');
  assert.equal(count(driver, 'legacy_snapshot'), 0);
});

/* ---------------------------------------------------------------------------
 * All or nothing: interrupted imports.
 * ------------------------------------------------------------------------ */

/** `makePredicate` is called per test, so a counting predicate starts fresh. */
function interruptAt(makePredicate, label) {
  test(`an import interrupted at ${label} leaves no partial state and retries whole`, async () => {
    const driver = createNodeDriver();
    const { db, kv } = setup({ driver });
    const raw = kv.data.get(KEY);
    driver.failOn(makePredicate());

    await assert.rejects(db.ready(), /injected failure/);
    assert.equal(count(driver, 'items'), 0, 'no partial import');
    assert.equal(count(driver, 'mutations'), 0);
    assert.equal(count(driver, 'legacy_snapshot'), 0);
    assert.equal(marker(driver), null, 'no completion marker');
    assert.equal(kv.data.get(KEY), raw, 'the source is untouched');

    // The next start-up — here, the next call — does the whole import again.
    assert.deepEqual(await db.listActive(), LEGACY_ITEMS);
    assert.equal(count(driver, 'mutations'), LEGACY_ITEMS.length);
  });
}

interruptAt(() => (sql) => sql.startsWith('INSERT OR IGNORE INTO legacy_snapshot'), 'the snapshot');
interruptAt(() => {
  let items = 0;
  return (sql) => sql.startsWith('INSERT OR IGNORE INTO items') && ++items === 3;
}, 'the third item');
interruptAt(() => (sql) => sql.startsWith('INSERT INTO sync_outbox'), 'an outbox entry');
interruptAt(() => (sql) => sql.startsWith('INSERT INTO meta'), 'the completion marker');
// The first COMMIT is the schema migration's; the second is the import's.
interruptAt(() => {
  let commits = 0;
  return (sql) => sql === 'COMMIT' && ++commits === 2;
}, 'the commit');

test('the import refuses to commit if an item does not read back identically', async () => {
  // A driver whose read-back returns a tampered row once: what a mapping bug
  // or a corrupted write would look like to the verification step.
  const tampered = createNodeDriver();
  const realAll = tampered.all.bind(tampered);
  let tamper = true;
  tampered.all = async (sql, params) => {
    const rows = await realAll(sql, params);
    if (tamper && sql.includes('FROM items WHERE id = ?') && rows[0]) {
      tamper = false;
      return [{ ...rows[0], name: 'corrupted' }];
    }
    return rows;
  };
  const second = setup({ driver: tampered });
  await assert.rejects(second.db.ready(), /verification/);
  assert.equal(count(tampered, 'items'), 0);
  assert.equal(marker(tampered), null);
});

test('an AsyncStorage read failure leaves the database untouched and is retried', async () => {
  const kv = createMemoryAsyncStorage();
  kv.data.set(KEY, envelope());
  const realGet = kv.getItem.bind(kv);
  let fail = true;
  kv.getItem = async (key) => {
    if (fail) {
      fail = false;
      throw new Error('AsyncStorage unavailable');
    }
    return realGet(key);
  };
  const { db, driver } = setup({ raw: null, kv });
  await assert.rejects(db.ready(), /AsyncStorage unavailable/);
  assert.equal(marker(driver), null);
  assert.deepEqual(await db.listActive(), LEGACY_ITEMS);
});

test('a process killed mid-import loses nothing: reopen and the import runs whole', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'useby-mig-'));
  const path = join(dir, 'useby.db');
  try {
    const kv = createMemoryAsyncStorage();
    kv.data.set(KEY, envelope());
    let driver = createNodeDriver(path);
    // Dies after some items are written; ROLLBACK never runs.
    driver.failOn((sql) => sql.startsWith('INSERT INTO meta') || sql === 'ROLLBACK', { sticky: true });
    await assert.rejects(setup({ raw: null, driver, kv }).db.ready());
    driver.close();

    driver = createNodeDriver(path);
    assert.equal(driver.db.prepare("SELECT COUNT(*) AS n FROM items").get().n, 0, 'torn import discarded');
    const { db } = setup({ raw: null, driver, kv });
    assert.deepEqual(await db.listActive(), LEGACY_ITEMS);
    driver.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ---------------------------------------------------------------------------
 * Once: duplicate execution.
 * ------------------------------------------------------------------------ */

test('a second start-up does not import again, even though the key is still there', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'useby-mig-'));
  const path = join(dir, 'useby.db');
  try {
    const kv = createMemoryAsyncStorage();
    kv.data.set(KEY, envelope());

    let driver = createNodeDriver(path);
    let first = setup({ raw: null, driver, kv });
    await first.db.ready();
    // A person edits and removes things after the import…
    await first.db.update('mfk2j8x2def', (c) => ({ ...c, name: 'Oat milk' }), 'm-edit');
    await first.db.remove('mfk2j8x1abc', 'used', 'm-used');
    driver.close();

    // …and the next launch must not bring the old versions back.
    driver = createNodeDriver(path);
    const second = setup({ raw: null, driver, kv });
    const list = await second.db.listActive();
    assert.equal(list.find((i) => i.id === 'mfk2j8x2def').name, 'Oat milk');
    assert.equal(list.find((i) => i.id === 'mfk2j8x1abc'), undefined);
    assert.equal(count(driver, 'mutations'), LEGACY_ITEMS.length + 2);
    assert.equal(second.reports[0].fresh, false, 'reported as the earlier import, not a new one');
    driver.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('concurrent first calls run the import once', async () => {
  const { db, driver } = setup();
  await Promise.all([db.ready(), db.listActive(), db.getActive('odd'), db.ready()]);
  assert.equal(count(driver, 'items'), LEGACY_ITEMS.length);
  assert.equal(count(driver, 'mutations'), LEGACY_ITEMS.length);
});

test('if the marker were ever lost, a re-import keeps SQLite\'s newer rows', async () => {
  const driver = createNodeDriver();
  const kv = createMemoryAsyncStorage();
  kv.data.set(KEY, envelope());
  let { db } = setup({ raw: null, driver, kv });
  await db.update('mfk2j8x2def', (c) => ({ ...c, name: 'Oat milk' }), 'm-edit');
  driver.db.exec("DELETE FROM meta WHERE key = 'legacy_import'");

  ({ db } = setup({ raw: null, driver, kv }));
  const list = await db.listActive();
  assert.equal(list.length, LEGACY_ITEMS.length, 'no duplicates');
  assert.equal(list.find((i) => i.id === 'mfk2j8x2def').name, 'Oat milk', 'not overwritten');
  assert.equal(marker(driver).alreadyPresent, LEGACY_ITEMS.length);
  assert.equal(marker(driver).imported, 0);
});

/* ---------------------------------------------------------------------------
 * Through the real service: the app works on imported data.
 * ------------------------------------------------------------------------ */

describe('service on an upgraded phone', () => {
  let stubs;
  let service;
  const PHOTOS = 'file:///doc/photos';

  before(async () => {
    mock.timers.enable({ apis: ['Date'], now: new Date(2026, 9, 15, 12, 0, 0) });
    stubs = install();
    // The phone as the previous build left it: the envelope, and two photos.
    stubs.asyncStorage.data.set(KEY, envelope());
    stubs.fileSystem.put(`${PHOTOS}/scan-p-cheddar.jpg`);
    stubs.fileSystem.put(`${PHOTOS}/scan-p-ham.jpg`);
    stubs.fileSystem.put(`${PHOTOS}/scan-orphan.jpg`);
    // The first open fails (say, the device is briefly out of space).
    stubs.sqlite.state.failNextOpen = true;
    service = await import('../src/domain/items/service.ts');
  });

  test('a failed first open is retried on the next call, and nothing is lost', async () => {
    await assert.rejects(service.getDerivedItems(), /injected open failure/);
    const list = await service.getDerivedItems();
    assert.equal(list.length, LEGACY_ITEMS.length);
  });

  test('Home shows every legacy item, urgency-sorted, with derived status', async () => {
    const list = await service.getDerivedItems();
    assert.deepEqual(list.map((i) => i.name), ['Milk', 'Ham', 'Mystery', 'Cheddar', 'Jam']);
    assert.ok(list.every((i) => i.status && typeof i.status.daysUntilDue === 'number'));
  });

  test('the start-up sweep keeps imported photos and collects only the orphan', async () => {
    assert.equal(await service.sweepOrphanPhotos(), 1);
    assert.ok(stubs.fileSystem.files.has(`${PHOTOS}/scan-p-cheddar.jpg`));
    assert.ok(stubs.fileSystem.files.has(`${PHOTOS}/scan-p-ham.jpg`));
  });

  test('editing an imported item keeps its id, photo, provenance and history', async () => {
    const before = await service.getDerivedItem('mfk2j8x3ghi');
    mock.timers.tick(60_000);
    const after = await service.updateItem('mfk2j8x3ghi', { name: 'Vintage cheddar', expiryDate: '2026-11-25' });
    assert.equal(after.id, before.id);
    assert.equal(after.photo, 'scan-p-cheddar.jpg');
    assert.equal(after.createdAt, before.createdAt);
    assert.equal(after.source, 'photo');
    assert.equal(after.dateType, 'best_before');
    assert.equal(after.dateUserSet, true);
    assert.notEqual(after.updatedAt, before.updatedAt);
    assert.equal(stubs.fileSystem.deleted.filter((p) => p.includes('cheddar')).length, 0);
  });

  test('Used on an imported item removes it and its photo; Delete likewise', async () => {
    await service.removeItem('mfk2j8x4jkl', 'used');
    await service.removeItem('mfk2j8x3ghi', 'deleted');
    const ids = (await service.getDerivedItems()).map((i) => i.id);
    assert.ok(!ids.includes('mfk2j8x4jkl'));
    assert.ok(!ids.includes('mfk2j8x3ghi'));
    assert.ok(!stubs.fileSystem.files.has(`${PHOTOS}/scan-p-ham.jpg`));
    assert.ok(!stubs.fileSystem.files.has(`${PHOTOS}/scan-p-cheddar.jpg`));

    const statuses = stubs.sqlite
      .raw()
      .prepare("SELECT id, status FROM items WHERE status != 'active' ORDER BY id")
      .all()
      .map((r) => `${r.id}:${r.status}`);
    assert.deepEqual(statuses, ['mfk2j8x3ghi:deleted', 'mfk2j8x4jkl:used']);
  });

  test('the AsyncStorage envelope is still exactly as the old build left it', () => {
    assert.equal(stubs.asyncStorage.data.get(KEY), envelope());
    assert.equal(stubs.asyncStorage.writes.length, 0);
  });

  test('new items saved after the upgrade sit beside the imported ones', async () => {
    const created = await service.createItem({ name: 'Bread', expiryDate: '2026-10-16' });
    const list = await service.getDerivedItems();
    assert.equal(list[0].id, created.id);
    assert.equal(list.length, LEGACY_ITEMS.length - 1);
  });
});
