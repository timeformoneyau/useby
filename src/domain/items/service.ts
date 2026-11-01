/**
 * Item Service — the single entry point for all item mutations.
 *
 * Screens must not import directly from storage. All persistence coordination
 * lives here.
 *
 * Every mutation is one SQLite transaction in the local item database
 * (`db/itemDatabase.ts`), applied one at a time, so two overlapping calls can
 * no longer lose one another's write. Each records a mutation, a lifecycle
 * event and a sync-outbox entry alongside the item; nothing sends the outbox
 * yet. The app is fully functional offline and has no account concept.
 * Hosted sync is a later phase.
 */

import { UseByItem } from '../../types';
import { CreateItemInput, DerivedItem } from './types';
import { itemDatabase } from './storage';
import { newId } from './db/ids';
import type { RemovalReason } from './db/itemDatabase';
import { deriveItem } from './derive';
import { applyItemEdit, editChangesAnything, type ItemEdit } from './edit';
import { photoStore } from './photoStore';
import { sortItems } from '../../utils/statusUtils';
import { emitItemsChanged } from './events';

export type { RemovalReason };

/** Load all items on the list, sorted by urgency, with derived fields attached. */
export async function getDerivedItems(): Promise<DerivedItem[]> {
  const items = await (await itemDatabase()).listActive();
  return sortItems(items).map(deriveItem);
}

/**
 * One item by id, or `null` if it is not there any more.
 *
 * `null` is an ordinary answer rather than an error: Item Detail is reached by
 * a navigation that outlives the record, so an item removed from another screen
 * — or on a second tap after Used — lands here legitimately. The screen shows
 * nothing and offers a way back rather than treating it as a fault.
 */
export async function getDerivedItem(itemId: string): Promise<DerivedItem | null> {
  const item = await (await itemDatabase()).getActive(itemId);
  return item ? deriveItem(item) : null;
}

/** Create a new item and persist it. */
export async function createItem(input: CreateItemInput): Promise<DerivedItem> {
  const now = new Date().toISOString();
  const item: UseByItem = {
    // A UUID for new items. Items saved before SQLite keep their old ids.
    id: newId(),
    name: input.name,
    expiryDate: input.expiryDate,
    dateType: input.dateType ?? 'unknown',
    // Already copied into durable storage by the caller before we got here, so
    // this is a name for a file that exists. Absent for a manual add, and
    // absent when the copy failed — both simply mean no photo.
    ...(input.photo ? { photo: input.photo } : {}),
    // Only when true. An absent field means "nothing was tracking this", which
    // is a different statement from "the date came from the packaging".
    ...(input.dateUserSet ? { dateUserSet: true } : {}),
    source: input.source ?? 'manual',
    createdAt: now,
    updatedAt: now,
  };

  const saved = await (await itemDatabase()).create(item, newId());
  emitItemsChanged();

  return deriveItem(saved);
}

/**
 * Change a saved item's name or Use By date.
 *
 * An update in place, never a delete and recreate. The item keeps its `id`, its
 * `createdAt`, its retained photo and its recorded provenance; only the two
 * editable fields and `updatedAt` move. What the new record looks like is
 * decided by `applyItemEdit`, which is pure and tested — this function is the
 * storage half and nothing more.
 *
 * **It does not touch the filesystem.** Metadata editing has nothing to do with
 * the photo: the filename is carried across unchanged, so there is no path here
 * that could orphan, duplicate or delete an image.
 *
 * Returns the updated item, or `null` if it is not there any more — reachable
 * when the item was removed from another screen while the editor was open, and
 * an ordinary answer rather than an error.
 *
 * The edit is applied to the row as it stands *inside* the transaction, not to
 * a copy read earlier, so an edit can never resurrect or overwrite a change
 * that landed while the editor was open.
 */
export async function updateItem(
  itemId: string,
  edit: ItemEdit,
): Promise<DerivedItem | null> {
  const { item, changed } = await (await itemDatabase()).update(
    itemId,
    // A Save that changes nothing is not a write. It should not bump
    // `updatedAt` and it must not mark the date as the user's — opening the
    // editor and pressing Save is not the same event as changing the date.
    (existing) =>
      editChangesAnything(existing, edit)
        ? applyItemEdit(existing, edit, new Date().toISOString())
        : null,
    newId(),
  );
  if (changed) emitItemsChanged();

  return item ? deriveItem(item) : null;
}

/**
 * Take an item off the list.
 *
 * Backs both user-facing actions: "Used" (the item was eaten, its job is
 * done) and "Delete" (it was added by mistake). On screen they behave
 * identically — the item leaves Home and its photo is deleted. In the
 * database they now differ: the row stays, marked `used` or `deleted`, with a
 * lifecycle event recording which. `reason` defaults to `deleted`, the
 * conservative reading, so a caller that does not say is never counted as
 * eaten.
 *
 * Removing an item that is not on the list (already gone, a double tap) is a
 * no-op, as it always was.
 */
export async function removeItem(
  itemId: string,
  reason: RemovalReason = 'deleted',
): Promise<void> {
  // Storage first, file second, and the order is load-bearing. If the process
  // dies between the two the result is a file nothing refers to, which the
  // start-up sweep collects and nobody ever sees. Reversed, it would leave an
  // item pointing at a file that is gone — a visible broken image, and the one
  // failure the user would actually notice. The row's photo reference is
  // cleared in the same commit as the status change.
  const going = await (await itemDatabase()).remove(itemId, reason, newId());
  photoStore.remove(going?.photo);
  if (going) emitItemsChanged();
}

/**
 * Delete every stored photo no item refers to.
 *
 * The backstop that turns "photos are usually cleaned up" into a guarantee. It
 * covers a crash between the two writes in `removeItem`, a delete that failed,
 * a save that stored a file and then could not write the item, and any path
 * nobody has thought of yet.
 *
 * **Start-up only, never on a timer.** A sweep running while a save is in
 * flight could delete the file for an item whose record has not landed yet.
 * At start-up there is nothing in flight to race.
 */
export async function sweepOrphanPhotos(): Promise<number> {
  return photoStore.sweep(await (await itemDatabase()).referencedPhotos());
}
