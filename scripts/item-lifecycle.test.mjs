/**
 * Regression guards for a saved item's whole life: created, listed in urgency
 * order, edited, marked Used or Deleted — through the real `service.ts`,
 * `storage.ts`, the SQLite item database and `statusUtils.ts`, against real
 * SQLite (`node:sqlite`, in memory), in-memory AsyncStorage and an in-memory
 * filesystem.
 *
 * "Persisted" below means what is in the SQLite `items` table, read straight
 * from the engine rather than through the service — what a cold start would
 * find. The AsyncStorage-era cases that seeded the old envelope mid-test now
 * live in `storage-migration.test.mjs`, because that envelope is read once, at
 * open, and never again.
 *
 * Until now these were device-test items only (see the note at the top of
 * `edit-items.test.mjs`): the pure edit rule was pinned, but nothing checked
 * that an edit *persists*, that a reload sees it, that the list re-sorts, or
 * that removing an item takes the right photo with it and no other. Those are
 * exactly the failures that look fine on the screen that caused them and show
 * up later — after a restart, or as someone else's empty photo frame.
 *
 * How it loads code that imports native modules: see `support/app-loader.mjs`.
 * No app code is changed or stubbed beyond AsyncStorage, expo-file-system and
 * expo-sqlite (which is real SQLite).
 *
 * The clock is frozen (Date only) so urgency is deterministic.
 */
import { test, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

import { install } from './support/fakes.mjs';

register('./support/app-loader.mjs', import.meta.url);
const stubs = install();

// Local noon, so no day boundary is anywhere near.
const NOW = new Date(2026, 9, 15, 12, 0, 0);
mock.timers.enable({ apis: ['Date'], now: NOW });

const service = await import('../src/domain/items/service.ts');
const { sortItems, computeItemStatus, secondaryLine } = await import(
  '../src/utils/statusUtils.ts'
);
const { saveScannedItem } = await import('../src/domain/items/saveScan.ts');
const { photoStore } = await import('../src/domain/items/photoStore.ts');
const { rowToItem } = await import('../src/domain/items/db/rows.ts');

const PHOTOS = 'file:///doc/photos';

/** YYYY-MM-DD, `n` days from the frozen today, in local time. */
function day(n) {
  const d = new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() + n);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/** What is actually in the database: the items still on the list, in stored order. */
function persisted() {
  const db = stubs.sqlite.raw();
  const items = db
    .prepare("SELECT * FROM items WHERE status = 'active' ORDER BY rowid")
    .all()
    .map((row) => rowToItem(row));
  return { items, version: db.prepare('PRAGMA user_version').get().user_version };
}

/** Every write the database has recorded: one mutation per change. */
function writeCount() {
  return stubs.sqlite.raw().prepare('SELECT COUNT(*) AS n FROM mutations').get().n;
}

/** Item rows of any status, keyed by id. */
function allRows() {
  return Object.fromEntries(
    stubs.sqlite.raw().prepare('SELECT * FROM items').all().map((r) => [r.id, r]),
  );
}

/** Save a scanned item the way the editor does: retain, create, release. */
async function saveScan({ scanId, name, expiryDate, dateType = 'use_by' }) {
  const cacheUri = `file:///cache/${scanId}.jpg`;
  stubs.fileSystem.put(cacheUri, `jpeg-${scanId}`);
  const released = [];
  await saveScannedItem(
    {
      retain: (id, uri) => photoStore.retain(id, uri),
      create: (input) => service.createItem(input),
      release: (id) => released.push(id),
    },
    { name, expiryDate, dateType, source: 'photo', scanId, photoUri: cacheUri },
  );
  return released;
}

beforeEach(() => {
  stubs.asyncStorage.reset();
  stubs.fileSystem.reset();
  stubs.sqlite.reset();
});

/* ---------------------------------------------------------------------------
 * The urgency ladder and the sort the list is built from.
 * ------------------------------------------------------------------------ */

test('status labels follow the urgency ladder at every boundary', () => {
  const label = (n) => computeItemStatus({ id: 'x', name: 'x', expiryDate: day(n) }).label;

  assert.equal(label(5), 'Fresh');
  assert.equal(label(4), 'Fresh');
  assert.equal(label(3), 'Use soon');
  assert.equal(label(1), 'Use soon');
  assert.equal(label(0), 'Use today');
  assert.equal(label(-1), 'Past use by');
  assert.equal(label(-6), 'Past use by');
  assert.equal(label(-7), 'Well past');
  assert.equal(label(-30), 'Well past');
});

test('days until due are calendar days, not elapsed hours', () => {
  // Noon today and midnight tomorrow are 12 hours apart and one day apart.
  const s = computeItemStatus({ id: 'x', name: 'x', expiryDate: day(1) });
  assert.equal(s.daysUntilDue, 1);
  assert.equal(secondaryLine(s), 'Use by tomorrow');
  assert.equal(secondaryLine(computeItemStatus({ id: 'x', name: 'x', expiryDate: day(0) })), 'Use by today');
  assert.equal(secondaryLine(computeItemStatus({ id: 'x', name: 'x', expiryDate: day(-1) })), '1 day past');
  assert.equal(secondaryLine(computeItemStatus({ id: 'x', name: 'x', expiryDate: day(-4) })), '4 days past');
  assert.equal(secondaryLine(computeItemStatus({ id: 'x', name: 'x', expiryDate: day(6) })), '6 days left');
});

test('the list is most urgent first, across and within bands', () => {
  const items = [
    { id: '1', name: 'Milk', expiryDate: day(6) },
    { id: '2', name: 'Cheddar', expiryDate: day(-3) },
    { id: '3', name: 'Yoghurt', expiryDate: day(2) },
    { id: '4', name: 'Chicken', expiryDate: day(0) },
    { id: '5', name: 'Ham', expiryDate: day(-10) },
    { id: '6', name: 'Bread', expiryDate: day(1) },
    { id: '7', name: 'Soup', expiryDate: day(-1) },
  ];

  assert.deepEqual(
    sortItems(items).map((i) => i.name),
    ['Ham', 'Cheddar', 'Soup', 'Chicken', 'Bread', 'Yoghurt', 'Milk'],
  );
});

test('items due the same day are ordered by name, so the list never shuffles', () => {
  const items = [
    { id: '1', name: 'Pears', expiryDate: day(2) },
    { id: '2', name: 'Apples', expiryDate: day(2) },
    { id: '3', name: 'Mince', expiryDate: day(2) },
  ];
  const once = sortItems(items).map((i) => i.id);
  const twice = sortItems([...items].reverse()).map((i) => i.id);

  assert.deepEqual(once, ['2', '3', '1']);
  assert.deepEqual(twice, once, 'input order does not leak into the result');
});

test('sorting does not mutate the stored array', () => {
  const items = [
    { id: '1', name: 'B', expiryDate: day(5) },
    { id: '2', name: 'A', expiryDate: day(-5) },
  ];
  sortItems(items);
  assert.deepEqual(items.map((i) => i.id), ['1', '2']);
});

/* ---------------------------------------------------------------------------
 * Create and reload.
 * ------------------------------------------------------------------------ */

test('a created item survives a reload, sorted and derived', async () => {
  await service.createItem({ name: 'Milk', expiryDate: day(6), dateType: 'use_by', source: 'manual' });
  await service.createItem({ name: 'Cheddar', expiryDate: day(-3), dateType: 'best_before', source: 'photo' });

  const env = persisted();
  assert.equal(env.version, 1, 'SQLite schema version');
  assert.equal(env.items.length, 2);

  const list = await service.getDerivedItems();
  assert.deepEqual(list.map((i) => i.name), ['Cheddar', 'Milk']);
  assert.equal(list[0].status.label, 'Past use by');
  assert.equal(list[0].dateType, 'best_before', 'what the pack said is stored as read');
  assert.equal(list[1].status.label, 'Fresh');
});

test('saves in quick succession each get their own identity', async () => {
  const ids = [];
  for (let i = 0; i < 10; i += 1) {
    ids.push((await service.createItem({ name: `Item ${i}`, expiryDate: day(i) })).id);
  }
  assert.equal(new Set(ids).size, 10, 'ids are unique even with the clock frozen');
  assert.equal(persisted().items.length, 10);
});

// Was a `todo` (KNOWN GAP) under the AsyncStorage envelope, whose every
// mutation was load → modify → save of the whole array. Fixed by the SQLite
// item database: one serial queue, one transaction per mutation. Broader
// overlap cases are in `item-database.test.mjs`.
test('overlapping writes do not lose an item', async () => {
  await Promise.all([
    service.createItem({ name: 'A', expiryDate: day(1) }),
    service.createItem({ name: 'B', expiryDate: day(2) }),
  ]);
  assert.equal(persisted().items.length, 2);
});

test('overlapping creates, edits and removals all land', async () => {
  const seed = [];
  for (let i = 0; i < 6; i += 1) {
    seed.push(await service.createItem({ name: `Item ${i}`, expiryDate: day(i + 1) }));
  }
  await Promise.all([
    service.createItem({ name: 'New 1', expiryDate: day(3) }),
    service.updateItem(seed[0].id, { name: 'Renamed 0' }),
    service.removeItem(seed[1].id, 'used'),
    service.createItem({ name: 'New 2', expiryDate: day(4) }),
    service.updateItem(seed[2].id, { expiryDate: day(9) }),
    service.removeItem(seed[3].id, 'deleted'),
    service.updateItem(seed[0].id, { expiryDate: day(8) }),
  ]);

  const names = persisted().items.map((i) => i.name).sort();
  assert.deepEqual(names, ['Item 2', 'Item 4', 'Item 5', 'New 1', 'New 2', 'Renamed 0']);
  const renamed = persisted().items.find((i) => i.id === seed[0].id);
  assert.equal(renamed.expiryDate, day(8), 'both edits to one item landed, neither lost');
  assert.equal(persisted().items.find((i) => i.id === seed[2].id).expiryDate, day(9));
});

/* ---------------------------------------------------------------------------
 * Editing: identity, photo and date persistence.
 * ------------------------------------------------------------------------ */

test('a date change persists, survives a reload and re-sorts the list', async () => {
  await saveScan({ scanId: 'p-milk', name: 'Milk', expiryDate: day(6) });
  await saveScan({ scanId: 'p-ham', name: 'Ham', expiryDate: day(2) });

  let list = await service.getDerivedItems();
  assert.deepEqual(list.map((i) => i.name), ['Ham', 'Milk']);
  const milk = list.find((i) => i.name === 'Milk');

  // The pack was misread: it is actually today.
  const updated = await service.updateItem(milk.id, { expiryDate: day(0) });
  assert.equal(updated.expiryDate, day(0));
  assert.equal(updated.status.label, 'Use today', 'status is derived from the new date');

  // A cold start sees exactly what was saved.
  const stored = persisted().items.find((i) => i.id === milk.id);
  assert.equal(stored.expiryDate, day(0));
  assert.equal(stored.dateUserSet, true);

  list = await service.getDerivedItems();
  assert.deepEqual(list.map((i) => i.name), ['Milk', 'Ham'], 'moved to the top');
});

test('editing keeps the item\'s identity, provenance and photo', async () => {
  await saveScan({ scanId: 'p-mince', name: 'Beef mince', expiryDate: day(3), dateType: 'best_before' });
  const [before] = persisted().items;
  assert.equal(before.photo, 'scan-p-mince.jpg');

  mock.timers.tick(60_000);
  await service.updateItem(before.id, { name: 'Lamb mince', expiryDate: day(4) });

  const items = persisted().items;
  assert.equal(items.length, 1, 'updated in place, not recreated');
  const [after] = items;
  assert.equal(after.id, before.id);
  assert.equal(after.createdAt, before.createdAt);
  assert.equal(after.source, 'photo');
  assert.equal(after.dateType, 'best_before', 'what the pack said is never rewritten');
  assert.equal(after.photo, before.photo);
  assert.notEqual(after.updatedAt, before.updatedAt);

  // And the file itself is still there, untouched.
  assert.ok(stubs.fileSystem.files.has(`${PHOTOS}/scan-p-mince.jpg`));
  assert.equal(stubs.fileSystem.deleted.length, 0);
  assert.equal(photoStore.uriFor(after.photo), `${PHOTOS}/scan-p-mince.jpg`);
});

test('an edited item\'s photo survives the start-up sweep', async () => {
  await saveScan({ scanId: 'p-a', name: 'A', expiryDate: day(3) });
  const [item] = persisted().items;
  await service.updateItem(item.id, { name: 'A2' });

  stubs.fileSystem.put(`${PHOTOS}/scan-orphan.jpg`);
  assert.equal(await service.sweepOrphanPhotos(), 1);
  assert.ok(stubs.fileSystem.files.has(`${PHOTOS}/scan-p-a.jpg`));
  assert.ok(!stubs.fileSystem.files.has(`${PHOTOS}/scan-orphan.jpg`));
});

test('a Save that changes nothing writes nothing', async () => {
  const created = await service.createItem({ name: 'Milk', expiryDate: day(5) });
  const writesBefore = writeCount();
  const rowBefore = allRows()[created.id];

  mock.timers.tick(60_000);
  const result = await service.updateItem(created.id, { name: '  Milk ', expiryDate: day(5) });

  assert.equal(result.id, created.id);
  assert.equal(writeCount(), writesBefore);
  assert.deepEqual(allRows()[created.id], rowBefore, 'row untouched, revision included');
  assert.equal(persisted().items[0].dateUserSet, undefined);
});

test('editing one item leaves every other item byte-for-byte alone', async () => {
  await saveScan({ scanId: 'p-1', name: 'One', expiryDate: day(1) });
  await saveScan({ scanId: 'p-2', name: 'Two', expiryDate: day(2) });
  await saveScan({ scanId: 'p-3', name: 'Three', expiryDate: day(3) });
  const before = persisted().items;
  const target = before.find((i) => i.name === 'Two');

  await service.updateItem(target.id, { expiryDate: day(9) });

  const after = persisted().items;
  assert.deepEqual(
    after.filter((i) => i.id !== target.id),
    before.filter((i) => i.id !== target.id),
  );
  assert.deepEqual(after.map((i) => i.id), before.map((i) => i.id), 'storage order kept');
});

test('editing an item removed elsewhere is an ordinary miss, not a write', async () => {
  const created = await service.createItem({ name: 'Milk', expiryDate: day(5) });
  await service.removeItem(created.id);
  const writes = writeCount();

  assert.equal(await service.updateItem(created.id, { name: 'Oat milk' }), null);
  assert.equal(writeCount(), writes);
  assert.deepEqual(persisted().items, []);
  assert.equal(allRows()[created.id].name, 'Milk', 'the removed record was not edited');
});

/* ---------------------------------------------------------------------------
 * Status transitions and removal.
 * ------------------------------------------------------------------------ */

test('an item moves through the ladder as its date is corrected', async () => {
  const { id } = await service.createItem({ name: 'Soup', expiryDate: day(-10) });
  const labels = [];
  for (const n of [-10, -2, 0, 2, 10]) {
    await service.updateItem(id, { expiryDate: day(n) });
    labels.push((await service.getDerivedItem(id)).status.label);
  }
  assert.deepEqual(labels, ['Well past', 'Past use by', 'Use today', 'Use soon', 'Fresh']);
});

test('Used / Delete removes that item, its photo, and nothing else', async () => {
  await saveScan({ scanId: 'p-milk', name: 'Milk', expiryDate: day(6) });
  await saveScan({ scanId: 'p-ham', name: 'Ham', expiryDate: day(2) });
  const milk = persisted().items.find((i) => i.name === 'Milk');

  await service.removeItem(milk.id);

  assert.deepEqual(persisted().items.map((i) => i.name), ['Ham']);
  assert.deepEqual(stubs.fileSystem.deleted, [`${PHOTOS}/scan-p-milk.jpg`]);
  assert.ok(stubs.fileSystem.files.has(`${PHOTOS}/scan-p-ham.jpg`));
  assert.equal(await service.getDerivedItem(milk.id), null);
});

test('Used and Delete look the same on screen but are recorded differently', async () => {
  await saveScan({ scanId: 'p-milk', name: 'Milk', expiryDate: day(6) });
  await saveScan({ scanId: 'p-ham', name: 'Ham', expiryDate: day(2) });
  const { items } = persisted();
  const milk = items.find((i) => i.name === 'Milk');
  const ham = items.find((i) => i.name === 'Ham');

  await service.removeItem(milk.id, 'used');
  await service.removeItem(ham.id, 'deleted');

  assert.deepEqual(await service.getDerivedItems(), [], 'both leave the list');
  const rows = allRows();
  assert.equal(rows[milk.id].status, 'used');
  assert.equal(rows[ham.id].status, 'deleted');
  assert.equal(rows[milk.id].photo, null, 'no row names a file that has gone');
  assert.equal(stubs.fileSystem.deleted.length, 2, 'both photos deleted, as before');

  const events = stubs.sqlite
    .raw()
    .prepare('SELECT item_id, kind FROM item_events ORDER BY seq')
    .all()
    .map((e) => `${e.item_id === milk.id ? 'milk' : 'ham'}:${e.kind}`);
  assert.deepEqual(events, ['milk:created', 'ham:created', 'milk:used', 'ham:deleted']);
});

test('a removal with no reason given is recorded as deleted, never as eaten', async () => {
  const { id } = await service.createItem({ name: 'Bread', expiryDate: day(1) });
  await service.removeItem(id);
  assert.equal(allRows()[id].status, 'deleted');
});

test('new items get UUIDs; every mutation is queued for a future sync', async () => {
  const { id } = await service.createItem({ name: 'Bread', expiryDate: day(1) });
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  await service.updateItem(id, { name: 'Rye' });
  await service.removeItem(id, 'used');

  const db = stubs.sqlite.raw();
  const outbox = db
    .prepare('SELECT m.kind, o.state FROM sync_outbox o JOIN mutations m ON m.id = o.mutation_id ORDER BY o.seq')
    .all()
    .map((r) => `${r.kind}:${r.state}`);
  assert.deepEqual(outbox, ['create:pending', 'edit:pending', 'use:pending']);
  const revisions = db.prepare('SELECT base_revision FROM mutations ORDER BY rowid').all();
  assert.deepEqual(revisions.map((r) => r.base_revision), [null, 1, 2]);
  assert.equal(db.prepare('SELECT revision FROM items WHERE id = ?').get(id).revision, 3);
});

test('the record goes before the file, so a crash cannot leave a broken image', async () => {
  await saveScan({ scanId: 'p-x', name: 'X', expiryDate: day(1) });
  const [item] = persisted().items;

  let storedWhenFileWent;
  stubs.fileSystem.hooks.onDelete = () => {
    storedWhenFileWent = persisted().items.map((i) => i.id);
  };
  await service.removeItem(item.id);

  assert.deepEqual(storedWhenFileWent, [], 'item was already gone from storage');
});

test('removing twice, or removing something unknown, is harmless', async () => {
  await saveScan({ scanId: 'p-a', name: 'A', expiryDate: day(1) });
  await saveScan({ scanId: 'p-b', name: 'B', expiryDate: day(2) });
  const a = persisted().items.find((i) => i.name === 'A');

  await service.removeItem(a.id);
  await service.removeItem(a.id); // double-tapped Used
  await service.removeItem('no-such-id');

  assert.deepEqual(persisted().items.map((i) => i.name), ['B']);
  assert.equal(stubs.fileSystem.deleted.length, 1);
});

test('removing an item whose photo file has already gone still removes it', async () => {
  await saveScan({ scanId: 'p-a', name: 'A', expiryDate: day(1) });
  stubs.fileSystem.files.delete(`${PHOTOS}/scan-p-a.jpg`);
  const [a] = persisted().items;

  await service.removeItem(a.id);
  assert.deepEqual(persisted().items, []);
});

test('removing the last item empties the list', async () => {
  const { id } = await service.createItem({ name: 'Bread', expiryDate: day(1) });
  await service.removeItem(id);
  assert.deepEqual(await service.getDerivedItems(), []);
});

/* ---------------------------------------------------------------------------
 * What Home and Item Detail will show for each item's photo.
 * ------------------------------------------------------------------------ */

test('a saved photo still resolves after a reload, for every item', async () => {
  await saveScan({ scanId: 'p-1', name: 'One', expiryDate: day(1) });
  await saveScan({ scanId: 'p-2', name: 'Two', expiryDate: day(2) });

  // A cold start: nothing in memory, only what was persisted.
  const list = await service.getDerivedItems();
  for (const item of list) {
    const state = photoStore.stateFor(item.photo);
    assert.equal(state.kind, 'ok', item.name);
    assert.equal(state.uri, `${PHOTOS}/${item.photo}`);
  }
});

test('an item saved before photos were kept shows the placeholder, not a fault', async () => {
  // An envelope-v2 record as the one-time import leaves it: no photo column
  // value, no source, no timestamps. (The import itself is pinned in
  // storage-migration.test.mjs; this is about how such a row reads.)
  stubs.sqlite
    .raw()
    .prepare("INSERT INTO items (id, name, expiry_date, date_type) VALUES ('old', 'Jam', ?, 'use_by')")
    .run(day(30));
  const [jam] = await service.getDerivedItems();
  assert.deepEqual(photoStore.stateFor(jam.photo), { kind: 'none' });
});

test('a manual add has no photo, by design', async () => {
  const { photo } = await service.createItem({ name: 'Bread', expiryDate: day(2) });
  assert.deepEqual(photoStore.stateFor(photo), { kind: 'none' });
});

test('a photo file lost from under its item reads as missing, and only that one', async () => {
  await saveScan({ scanId: 'p-a', name: 'A', expiryDate: day(1) });
  await saveScan({ scanId: 'p-b', name: 'B', expiryDate: day(2) });
  stubs.fileSystem.files.delete(`${PHOTOS}/scan-p-a.jpg`);

  const byName = Object.fromEntries((await service.getDerivedItems()).map((i) => [i.name, i]));
  assert.deepEqual(photoStore.stateFor(byName.A.photo), { kind: 'missing', filename: 'scan-p-a.jpg' });
  assert.equal(photoStore.stateFor(byName.B.photo).kind, 'ok');
});

test('Used / Delete, editing and the start-up sweep leave other items\' photos showing', async () => {
  await saveScan({ scanId: 'p-1', name: 'One', expiryDate: day(1) });
  await saveScan({ scanId: 'p-2', name: 'Two', expiryDate: day(2) });
  await saveScan({ scanId: 'p-3', name: 'Three', expiryDate: day(3) });
  const byName = () => Object.fromEntries(persisted().items.map((i) => [i.name, i]));

  await service.updateItem(byName().Two.id, { name: 'Two edited' });
  await service.removeItem(byName().One.id);
  await service.sweepOrphanPhotos();

  const left = await service.getDerivedItems();
  assert.deepEqual(left.map((i) => i.name).sort(), ['Three', 'Two edited']);
  for (const item of left) assert.equal(photoStore.stateFor(item.photo).kind, 'ok', item.name);
});
