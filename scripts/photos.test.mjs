/**
 * Offline guards for the durable photo lifecycle.
 *
 * `photos.ts` and `saveScan.ts` both take their dependencies by injection and
 * have no value imports, so Node's type stripping loads them and the whole
 * lifecycle runs here against a fake filesystem — including every failure path,
 * which is the actual reason for the shape. A copy that fails, a write that
 * fails after a successful copy, a file that vanishes between operations: none
 * of those can be provoked against a real device, and all of them decide
 * whether a saved item ends up pointing at a photograph that is not there.
 *
 * The ownership rule these protect, stated once:
 *
 *   a pending scan owns a temporary image; a saved item owns a durable image.
 *
 * Every test below is a way that rule could quietly stop being true.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createPhotoStore,
  isPhotoFilename,
  orphanPhotos,
  photoFilename,
} from '../src/domain/items/photos.ts';
import { saveScannedItem } from '../src/domain/items/saveScan.ts';

/**
 * A filesystem in a Map.
 *
 * `failCopy` and `failDelete` are the point: the interesting behaviour is what
 * happens when the filesystem says no, and a real one will not do that on
 * demand.
 */
function fakeFs(options = {}) {
  const files = new Map();
  let dirMade = false;

  return {
    files,
    get dirMade() {
      return dirMade;
    },
    fs: {
      ensureDir() {
        if (options.failEnsureDir) throw new Error('no directory');
        dirMade = true;
      },
      copy(sourceUri, filename) {
        if (options.failCopy) throw new Error('copy failed');
        // A copy from a source that is not there is a failure, same as the
        // real thing — this is the cache file having been reclaimed.
        if (options.missingSource) throw new Error('source gone');
        files.set(filename, `copied:${sourceUri}`);
      },
      delete(filename) {
        if (options.failDelete) throw new Error('delete failed');
        files.delete(filename);
      },
      exists(filename) {
        // Models a copy that reports success and produces nothing.
        if (options.copyIsALie && files.has(filename)) return false;
        return files.has(filename);
      },
      list() {
        if (options.failList) throw new Error('no directory');
        return [...files.keys()];
      },
      uriFor(filename) {
        return `file:///documents/photos/${filename}`;
      },
    },
  };
}

/* ---------------------------------------------------------------------------
 * Naming. The filename is the stored reference, so its rules are the data
 * model's rules.
 * ------------------------------------------------------------------------ */

test('a photo is named after the scan that produced it', () => {
  assert.equal(photoFilename('p-mfk2j8x1-4b7c9'), 'scan-p-mfk2j8x1-4b7c9.jpg');
});

test('a scan id that could escape the photos directory is refused', () => {
  // Ids are minted locally so this is not an attack surface, but a filename is
  // exactly the wrong place to discover that assumption was wrong.
  assert.equal(photoFilename('../../etc/passwd'), null);
  assert.equal(photoFilename('a/b'), null);
  assert.equal(photoFilename(''), null);
  assert.equal(photoFilename('x'.repeat(65)), null);
});

test('only our own filenames are recognised as ours', () => {
  assert.equal(isPhotoFilename('scan-p-abc.jpg'), true);
  assert.equal(isPhotoFilename('scan-p-abc.png'), false);
  assert.equal(isPhotoFilename('holiday.jpg'), false);
  assert.equal(isPhotoFilename('scan-../x.jpg'), false);
});

/* ---------------------------------------------------------------------------
 * Retain — the temporary-to-durable transition.
 * ------------------------------------------------------------------------ */

test('retaining copies the scan image and returns the stored name', () => {
  const { fs, files } = fakeFs();
  const store = createPhotoStore(fs);

  const name = store.retain('p-abc', 'file:///cache/scan.jpg');

  assert.equal(name, 'scan-p-abc.jpg');
  assert.equal(files.get('scan-p-abc.jpg'), 'copied:file:///cache/scan.jpg');
});

test('retaining creates the photos directory first', () => {
  const fake = fakeFs();
  createPhotoStore(fake.fs).retain('p-abc', 'file:///cache/scan.jpg');
  assert.equal(fake.dirMade, true);
});

test('a failed copy returns null rather than throwing', () => {
  // The item must still save. Losing a photo is a degradation; losing the
  // groceries because a file copy failed would be absurd.
  const { fs } = fakeFs({ failCopy: true });
  assert.equal(createPhotoStore(fs).retain('p-abc', 'file:///cache/scan.jpg'), null);
});

test('a cache file that vanished before Save is survivable', () => {
  const { fs } = fakeFs({ missingSource: true });
  assert.equal(createPhotoStore(fs).retain('p-abc', 'file:///cache/scan.jpg'), null);
});

test('a copy that reports success but produces nothing returns null', () => {
  // The worst outcome this module can produce is a name for a file that is not
  // there — invisible until someone opens the item weeks later. So the name is
  // only handed back once the file has been confirmed present.
  const { fs } = fakeFs({ copyIsALie: true });
  assert.equal(createPhotoStore(fs).retain('p-abc', 'file:///cache/scan.jpg'), null);
});

test('retaining over an existing file replaces it', () => {
  // Reachable: a save is retried after a failed write, so the same scan id
  // copies to the same name twice.
  const { fs, files } = fakeFs();
  const store = createPhotoStore(fs);

  store.retain('p-abc', 'file:///cache/first.jpg');
  const name = store.retain('p-abc', 'file:///cache/second.jpg');

  assert.equal(name, 'scan-p-abc.jpg');
  assert.equal(files.get('scan-p-abc.jpg'), 'copied:file:///cache/second.jpg');
  assert.equal(files.size, 1, 'not two files for one scan');
});

test('a directory that cannot be created is not fatal', () => {
  const { fs } = fakeFs({ failEnsureDir: true });
  assert.equal(createPhotoStore(fs).retain('p-abc', 'file:///cache/scan.jpg'), null);
});

/* ---------------------------------------------------------------------------
 * Reading — what Item Detail renders on.
 * ------------------------------------------------------------------------ */

test('an item with a photo resolves to a URI', () => {
  const { fs } = fakeFs();
  assert.equal(
    createPhotoStore(fs).uriFor('scan-p-abc.jpg'),
    'file:///documents/photos/scan-p-abc.jpg',
  );
});

test('an item with no photo resolves to null, not an empty frame', () => {
  // Manual adds, and every item saved before photos existed. The detail screen
  // renders no photo block at all on a null, which is the point.
  const { fs } = fakeFs();
  const store = createPhotoStore(fs);

  assert.equal(store.uriFor(undefined), null);
  assert.equal(store.uriFor(''), null);
});

test('a stored value that is not one of our filenames is refused', () => {
  // Belt against a record written by a future version, or hand-edited storage:
  // never build a URI out of something we did not name.
  const { fs } = fakeFs();
  assert.equal(createPhotoStore(fs).uriFor('/etc/passwd'), null);
});

/* ---------------------------------------------------------------------------
 * Removal — a deleted item takes its photo with it.
 * ------------------------------------------------------------------------ */

test('removing an item deletes its photo', () => {
  const { fs, files } = fakeFs();
  const store = createPhotoStore(fs);
  store.retain('p-abc', 'file:///cache/scan.jpg');

  store.remove('scan-p-abc.jpg');

  assert.equal(files.size, 0);
});

test('removing an item that never had a photo does nothing', () => {
  const { fs, files } = fakeFs();
  const store = createPhotoStore(fs);
  store.retain('p-keep', 'file:///cache/keep.jpg');

  store.remove(undefined);

  assert.equal(files.size, 1, 'the other photo is untouched');
});

test('a delete that fails does not throw at the user', () => {
  // They just tapped "Used it". A filesystem error is not something they can
  // act on, and the sweep collects the file later.
  const { fs } = fakeFs({ failDelete: true });
  const store = createPhotoStore(fs);
  store.retain('p-abc', 'file:///cache/scan.jpg');

  assert.doesNotThrow(() => store.remove('scan-p-abc.jpg'));
});

/* ---------------------------------------------------------------------------
 * The sweep — the backstop that makes cleanup a guarantee rather than a habit.
 * ------------------------------------------------------------------------ */

test('the sweep deletes photos no item refers to', () => {
  const { fs, files } = fakeFs();
  const store = createPhotoStore(fs);
  store.retain('p-kept', 'file:///cache/a.jpg');
  store.retain('p-orphan', 'file:///cache/b.jpg');

  const removed = store.sweep(['scan-p-kept.jpg']);

  assert.equal(removed, 1);
  assert.deepEqual([...files.keys()], ['scan-p-kept.jpg']);
});

test('the sweep ignores items with no photo', () => {
  const { fs, files } = fakeFs();
  const store = createPhotoStore(fs);
  store.retain('p-kept', 'file:///cache/a.jpg');

  // Most items have no photo, so the referenced list is mostly undefined.
  store.sweep([undefined, 'scan-p-kept.jpg', undefined]);

  assert.equal(files.size, 1);
});

test('the sweep never touches a file it did not write', () => {
  const { fs, files } = fakeFs();
  files.set('something-else.jpg', 'not ours');
  const store = createPhotoStore(fs);
  store.retain('p-orphan', 'file:///cache/b.jpg');

  store.sweep([]);

  assert.deepEqual([...files.keys()], ['something-else.jpg']);
});

test('sweeping before any photo exists is not an error', () => {
  // The ordinary state at first launch: there is no photos directory yet.
  const { fs } = fakeFs({ failList: true });
  assert.equal(createPhotoStore(fs).sweep([]), 0);
});

test('orphan detection is a pure function of the two lists', () => {
  assert.deepEqual(
    orphanPhotos(['scan-a.jpg', 'scan-b.jpg', 'notes.txt'], ['scan-b.jpg']),
    ['scan-a.jpg'],
  );
  assert.deepEqual(orphanPhotos([], ['scan-b.jpg']), []);
});

/* ---------------------------------------------------------------------------
 * The Save handover. Retain, create, release — and what each failure does.
 * ------------------------------------------------------------------------ */

function recorder(over = {}) {
  const calls = { retain: [], create: [], release: [] };
  return {
    calls,
    deps: {
      retain: (id, uri) => {
        calls.retain.push([id, uri]);
        return over.retain === undefined ? `scan-${id}.jpg` : over.retain;
      },
      create: async (input) => {
        calls.create.push(input);
        if (over.createThrows) throw new Error('storage full');
      },
      release: (id) => calls.release.push(id),
    },
  };
}

const request = (over = {}) => ({
  name: 'Beef mince',
  expiryDate: '2026-09-03',
  dateType: 'use_by',
  source: 'photo',
  scanId: 'p-abc',
  photoUri: 'file:///cache/p-abc.jpg',
  ...over,
});

test('saving a scan retains the photo, stores its name, then releases the draft', async () => {
  const { calls, deps } = recorder();

  await saveScannedItem(deps, request());

  assert.deepEqual(calls.retain, [['p-abc', 'file:///cache/p-abc.jpg']]);
  assert.equal(calls.create[0].photo, 'scan-p-abc.jpg', 'the item names the file');
  assert.deepEqual(calls.release, ['p-abc'], 'and only then is the draft retired');
});

test('the draft is released after the item is written, never before', async () => {
  // Ordering, stated outright. Reversed, a failed write takes the scan with it
  // and the user is left with neither an item nor the draft they were editing.
  const order = [];
  await saveScannedItem(
    {
      retain: () => {
        order.push('retain');
        return 'scan-p-abc.jpg';
      },
      create: async () => {
        order.push('create');
      },
      release: () => order.push('release'),
    },
    request(),
  );

  assert.deepEqual(order, ['retain', 'create', 'release']);
});

test('a failed copy saves the item anyway, with no photo', async () => {
  const { calls, deps } = recorder({ retain: null });

  await saveScannedItem(deps, request());

  assert.equal('photo' in calls.create[0], false, 'no photo field at all');
  assert.deepEqual(calls.release, ['p-abc'], 'the draft is still retired');
});

test('a failed write keeps the draft so the user can try again', async () => {
  const { calls, deps } = recorder({ createThrows: true });

  await assert.rejects(() => saveScannedItem(deps, request()));

  assert.deepEqual(calls.release, [], 'nothing retired');
  // A durable file may exist that nothing refers to. That is the safe
  // direction: the start-up sweep collects it and nobody ever sees it.
  assert.equal(calls.retain.length, 1);
});

test('a manual add touches no photo machinery at all', async () => {
  const { calls, deps } = recorder();

  await saveScannedItem(deps, request({ scanId: undefined, photoUri: undefined }));

  assert.deepEqual(calls.retain, []);
  assert.deepEqual(calls.release, []);
  assert.equal('photo' in calls.create[0], false);
});

test('a draft whose image was already lost still saves and still releases', async () => {
  const { calls, deps } = recorder();

  await saveScannedItem(deps, request({ photoUri: undefined }));

  assert.deepEqual(calls.retain, [], 'nothing to copy');
  assert.equal('photo' in calls.create[0], false);
  assert.deepEqual(calls.release, ['p-abc'], 'the draft is still retired');
});

test('the saved item carries the reviewed fields, not the scan plumbing', async () => {
  const { calls, deps } = recorder();

  await saveScannedItem(deps, request({ name: 'Edited name' }));

  const input = calls.create[0];
  assert.equal(input.name, 'Edited name');
  assert.equal(input.expiryDate, '2026-09-03');
  assert.equal(input.dateType, 'use_by');
  assert.equal(input.source, 'photo');
  assert.equal('scanId' in input, false, 'scanId is not part of the item');
  assert.equal('photoUri' in input, false, 'nor is the temporary URI');
});
