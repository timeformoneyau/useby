/**
 * Regression guards for a saved item's whole life: created, listed in urgency
 * order, edited, marked Used or Deleted — through the real `service.ts`,
 * `storage.ts` and `statusUtils.ts`, against in-memory AsyncStorage and an
 * in-memory filesystem.
 *
 * Until now these were device-test items only (see the note at the top of
 * `edit-items.test.mjs`): the pure edit rule was pinned, but nothing checked
 * that an edit *persists*, that a reload sees it, that the list re-sorts, or
 * that removing an item takes the right photo with it and no other. Those are
 * exactly the failures that look fine on the screen that caused them and show
 * up later — after a restart, or as someone else's empty photo frame.
 *
 * How it loads code that imports native modules: see `support/app-loader.mjs`.
 * No app code is changed or stubbed beyond AsyncStorage and expo-file-system.
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

const STORAGE_KEY = '@useby_v1_items';
const PHOTOS = 'file:///doc/photos';

/** YYYY-MM-DD, `n` days from the frozen today, in local time. */
function day(n) {
  const d = new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() + n);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/** What is actually on "disk", re-read the way a cold start would. */
function persisted() {
  const raw = stubs.asyncStorage.data.get(STORAGE_KEY);
  return raw ? JSON.parse(raw) : null;
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
  assert.equal(env.version, 4);
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

test(
  'overlapping writes do not lose an item',
  {
    todo:
      'KNOWN GAP: every mutation is load → modify → save of the whole array with no ' +
      'serialisation, so two overlapping writes lose one. Through the current UI it ' +
      'needs two writes (e.g. Used on two rows) inside the few ms one AsyncStorage ' +
      'write takes, so unlikely by hand — but it becomes real the moment anything ' +
      'writes in the background. The planned SQLite slice removes it.',
  },
  async () => {
    await Promise.all([
      service.createItem({ name: 'A', expiryDate: day(1) }),
      service.createItem({ name: 'B', expiryDate: day(2) }),
    ]);
    assert.equal(persisted().items.length, 2);
  },
);

test('records storage cannot read are dropped, not fatal', async () => {
  stubs.asyncStorage.data.set(STORAGE_KEY, '{not json');
  assert.deepEqual(await service.getDerivedItems(), []);

  stubs.asyncStorage.data.set(
    STORAGE_KEY,
    JSON.stringify({
      version: 4,
      items: [
        { id: 'ok', name: 'Milk', expiryDate: day(1) },
        { id: 'bad', name: 'No date' },
        null,
        'junk',
      ],
    }),
  );
  assert.deepEqual((await service.getDerivedItems()).map((i) => i.id), ['ok']);
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
  const writesBefore = stubs.asyncStorage.writes.length;
  const rawBefore = stubs.asyncStorage.data.get(STORAGE_KEY);

  mock.timers.tick(60_000);
  const result = await service.updateItem(created.id, { name: '  Milk ', expiryDate: day(5) });

  assert.equal(result.id, created.id);
  assert.equal(stubs.asyncStorage.writes.length, writesBefore);
  assert.equal(stubs.asyncStorage.data.get(STORAGE_KEY), rawBefore);
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
  const writes = stubs.asyncStorage.writes.length;

  assert.equal(await service.updateItem(created.id, { name: 'Oat milk' }), null);
  assert.equal(stubs.asyncStorage.writes.length, writes);
  assert.deepEqual(persisted().items, []);
});

test('a record from before photos and date types edits and saves safely', async () => {
  stubs.asyncStorage.data.set(
    STORAGE_KEY,
    JSON.stringify({ version: 1, items: [{ id: 'old', name: 'Jam', expiryDate: day(30) }] }),
  );
  await service.updateItem('old', { expiryDate: day(20) });

  const env = persisted();
  assert.equal(env.version, 4);
  assert.deepEqual(Object.keys(env.items[0]).sort(), [
    'dateUserSet', 'expiryDate', 'id', 'name', 'updatedAt',
  ]);
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
