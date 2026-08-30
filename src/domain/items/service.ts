/**
 * Item Service — the single entry point for all item mutations.
 *
 * Screens must not import directly from storage. All persistence coordination
 * lives here.
 *
 * Ported from since-fresh with the cloud half removed: no sync queue, no
 * background sync, no notification scheduling. Every mutation is a local
 * AsyncStorage write, so the app is fully functional offline and has no
 * account concept. Supabase-backed sync is a later phase.
 */

import { UseByItem } from '../../types';
import { CreateItemInput, DerivedItem } from './types';
import { loadItems, saveItems } from './storage';
import { deriveItem } from './derive';
import { photoStore } from './photoStore';
import { sortItems } from '../../utils/statusUtils';

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

/** Load all items, sorted by urgency, with derived fields attached. */
export async function getDerivedItems(): Promise<DerivedItem[]> {
  const items = await loadItems();
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
  const items = await loadItems();
  const item = items.find((i) => i.id === itemId);
  return item ? deriveItem(item) : null;
}

/** Create a new item and persist it. */
export async function createItem(input: CreateItemInput): Promise<DerivedItem> {
  const now = new Date().toISOString();
  const item: UseByItem = {
    id: generateId(),
    name: input.name,
    expiryDate: input.expiryDate,
    dateType: input.dateType ?? 'unknown',
    // Already copied into durable storage by the caller before we got here, so
    // this is a name for a file that exists. Absent for a manual add, and
    // absent when the copy failed — both simply mean no photo.
    ...(input.photo ? { photo: input.photo } : {}),
    source: input.source ?? 'manual',
    createdAt: now,
    updatedAt: now,
  };

  const existing = await loadItems();
  await saveItems([...existing, item]);

  return deriveItem(item);
}

/**
 * Remove an item from the list.
 *
 * Backs both user-facing actions: "Used" (the item was eaten, its job is
 * done) and "Delete" (it was added by mistake). since-fresh distinguished
 * these because marking a recurring chore done restarted its cycle — with
 * expiry-only items there is no cycle to restart, so both simply drop the
 * item. They stay separate in the UI because they mean different things.
 */
export async function removeItem(itemId: string): Promise<void> {
  const items = await loadItems();
  const going = items.find((i) => i.id === itemId);

  // Storage first, file second, and the order is load-bearing. If the process
  // dies between the two the result is a file nothing refers to, which the
  // start-up sweep collects and nobody ever sees. Reversed, it would leave an
  // item pointing at a file that is gone — a visible broken image, and the one
  // failure the user would actually notice.
  await saveItems(items.filter((i) => i.id !== itemId));
  photoStore.remove(going?.photo);
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
  const items = await loadItems();
  return photoStore.sweep(items.map((i) => i.photo));
}
