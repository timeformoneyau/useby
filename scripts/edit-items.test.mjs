/**
 * Offline guards for editing a saved item.
 *
 * `applyItemEdit` is pure and has no value imports, so the whole rule set runs
 * here. That matters because almost everything worth protecting about an edit
 * is a statement about what *did not* change: the identity, the photo, the
 * provenance. Those are invisible failures — an edit that quietly drops a photo
 * filename looks fine on the screen that made it and shows an empty frame weeks
 * later.
 *
 * `updateItem` itself is the storage half and lives in `service.ts`, which
 * imports AsyncStorage and cannot be loaded here. What it does is load, call
 * this function, and write the result back; the decision being tested is all
 * of it. The persistence round trip and the after-editing behaviour of
 * Used/Delete are device-test items, listed as such in the Build Log.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { applyItemEdit, editChangesAnything } from '../src/domain/items/edit.ts';

const NOW = '2026-08-31T09:00:00.000Z';

/** A scanned item with everything a record can carry. */
const item = (over = {}) => ({
  id: 'itm-1',
  name: 'Beef mince',
  expiryDate: '2026-09-04',
  dateType: 'best_before',
  photo: 'scan-p-abc.jpg',
  source: 'photo',
  createdAt: '2026-08-30T08:00:00.000Z',
  updatedAt: '2026-08-30T08:00:00.000Z',
  ...over,
});

/* ---------------------------------------------------------------------------
 * The three edits.
 * ------------------------------------------------------------------------ */

test('renaming changes the name and nothing else', () => {
  const before = item();
  const after = applyItemEdit(before, { name: 'Beef mince 500g' }, NOW);

  assert.equal(after.name, 'Beef mince 500g');
  assert.equal(after.expiryDate, before.expiryDate);
  assert.equal(after.updatedAt, NOW);
});

test('re-dating changes the date and nothing else', () => {
  const after = applyItemEdit(item(), { expiryDate: '2026-09-12' }, NOW);

  assert.equal(after.expiryDate, '2026-09-12');
  assert.equal(after.name, 'Beef mince');
});

test('both at once', () => {
  const after = applyItemEdit(item(), { name: 'Lamb mince', expiryDate: '2026-09-12' }, NOW);

  assert.equal(after.name, 'Lamb mince');
  assert.equal(after.expiryDate, '2026-09-12');
});

test('an omitted field is not an instruction to clear it', () => {
  const after = applyItemEdit(item(), {}, NOW);
  assert.equal(after.name, 'Beef mince');
  assert.equal(after.expiryDate, '2026-09-04');
});

test('a name is trimmed, and an empty one is refused rather than saved', () => {
  assert.equal(applyItemEdit(item(), { name: '  Milk  ' }, NOW).name, 'Milk');
  // The editor disables Save without a name; this is the second line. An item
  // with no name cannot be found again by the person who owns it.
  assert.equal(applyItemEdit(item(), { name: '   ' }, NOW).name, 'Beef mince');
});

/* ---------------------------------------------------------------------------
 * What an edit must never disturb.
 * ------------------------------------------------------------------------ */

test('identity survives an edit', () => {
  // Editing is an update in place, never a delete and recreate. A new id would
  // break every reference to the item, its retained photo among them.
  const before = item();
  const after = applyItemEdit(before, { name: 'Renamed', expiryDate: '2026-10-01' }, NOW);

  assert.equal(after.id, before.id);
  assert.equal(after.createdAt, before.createdAt, 'when it was added does not move');
  assert.equal(after.source, before.source, 'how it came into existence does not change');
});

test('the retained photo reference is carried across untouched', () => {
  // The invisible failure this guards: an edit that drops the filename leaves
  // the file orphaned on disk and the item showing nothing, and neither is
  // noticeable on the screen that caused it.
  const after = applyItemEdit(item(), { name: 'Renamed', expiryDate: '2026-10-01' }, NOW);
  assert.equal(after.photo, 'scan-p-abc.jpg');
});

test('an item with no photo edits normally', () => {
  const manual = item({ photo: undefined, source: 'manual', dateType: 'unknown' });
  const after = applyItemEdit(manual, { name: 'Bread' }, NOW);

  assert.equal(after.name, 'Bread');
  assert.equal('photo' in after && after.photo !== undefined, false);
});

test('the input is not mutated', () => {
  const before = item();
  applyItemEdit(before, { name: 'Renamed', expiryDate: '2026-10-01' }, NOW);

  assert.equal(before.name, 'Beef mince');
  assert.equal(before.expiryDate, '2026-09-04');
});

/* ---------------------------------------------------------------------------
 * Provenance: what the packaging said, and whose date this now is.
 * ------------------------------------------------------------------------ */

test('what the packaging said is never rewritten by an edit', () => {
  // The pack said BEST BEFORE. It still did, whatever the user typed. Clearing
  // this would destroy an observation; changing it to use_by would invent one.
  const after = applyItemEdit(item(), { expiryDate: '2026-09-12' }, NOW);
  assert.equal(after.dateType, 'best_before');
});

test('changing the date marks it as the user\'s, not the pack\'s', () => {
  // This is what stops `dateType` becoming a lie. The classification describes
  // the date the model read; once a person replaces that date, the two are
  // about different things, and anything acting on date semantics later needs
  // to be able to see that.
  const after = applyItemEdit(item(), { expiryDate: '2026-09-12' }, NOW);
  assert.equal(after.dateUserSet, true);
});

test('renaming alone does not claim the user set the date', () => {
  const after = applyItemEdit(item(), { name: 'Beef mince 500g' }, NOW);
  assert.equal(after.dateUserSet, undefined);
});

test('setting the date to the value it already had is not a change', () => {
  const after = applyItemEdit(item(), { expiryDate: '2026-09-04' }, NOW);
  assert.equal(after.dateUserSet, undefined);
});

test('once the date is the user\'s it stays the user\'s', () => {
  // Fixing a typo in the name later must not hand the date back to the packaging.
  const corrected = item({ dateUserSet: true });
  const after = applyItemEdit(corrected, { name: 'Beef mince 500g' }, NOW);
  assert.equal(after.dateUserSet, true);
});

/* ---------------------------------------------------------------------------
 * Records written before any of this existed.
 * ------------------------------------------------------------------------ */

test('a record from before photos or date types edits safely', () => {
  // A v1 record: no dateType, no photo, no dateUserSet. It must load, edit and
  // come out still valid — nothing here invents fields it never had.
  const old = {
    id: 'itm-old',
    name: 'Yoghurt',
    expiryDate: '2026-09-01',
    source: 'manual',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
  };
  const after = applyItemEdit(old, { name: 'Greek yoghurt' }, NOW);

  assert.equal(after.name, 'Greek yoghurt');
  assert.equal(after.id, 'itm-old');
  assert.equal(after.dateType, undefined, 'not invented');
  assert.equal(after.photo, undefined);
  assert.equal(after.dateUserSet, undefined);
});

test('every stored date type edits the same way', () => {
  // The product decision, from the data side: use_by, best_before, unknown and
  // absent are one concept to the reader and four distinct records underneath.
  for (const dateType of ['use_by', 'best_before', 'unknown', undefined]) {
    const after = applyItemEdit(item({ dateType }), { expiryDate: '2026-09-12' }, NOW);
    assert.equal(after.expiryDate, '2026-09-12', String(dateType));
    assert.equal(after.dateType, dateType, `${dateType} survives untouched`);
    assert.equal(after.dateUserSet, true, String(dateType));
  }
});

/* ---------------------------------------------------------------------------
 * Cancel, and the Save that changes nothing.
 * ------------------------------------------------------------------------ */

test('an edit that changes nothing is recognised as such', () => {
  // `updateItem` returns early on this, so Cancel — and a Save with no edits —
  // write nothing at all. Without it, opening the editor and pressing Save
  // would bump `updatedAt` and, worse, could mark the date as the user's when
  // they never touched it.
  const before = item();
  assert.equal(editChangesAnything(before, {}), false);
  assert.equal(editChangesAnything(before, { name: 'Beef mince' }), false);
  assert.equal(editChangesAnything(before, { name: '  Beef mince  ' }), false);
  assert.equal(editChangesAnything(before, { expiryDate: '2026-09-04' }), false);
});

test('a real change is recognised as one', () => {
  const before = item();
  assert.equal(editChangesAnything(before, { name: 'Lamb mince' }), true);
  assert.equal(editChangesAnything(before, { expiryDate: '2026-09-12' }), true);
});
