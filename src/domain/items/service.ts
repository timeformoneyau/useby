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
import { sortItems } from '../../utils/statusUtils';

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

/** Load all items, sorted by urgency, with derived fields attached. */
export async function getDerivedItems(): Promise<DerivedItem[]> {
  const items = await loadItems();
  return sortItems(items).map(deriveItem);
}

/** Create a new item and persist it. */
export async function createItem(input: CreateItemInput): Promise<DerivedItem> {
  const now = new Date().toISOString();
  const item: UseByItem = {
    id: generateId(),
    name: input.name,
    expiryDate: input.expiryDate,
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
  await saveItems(items.filter((i) => i.id !== itemId));
}
