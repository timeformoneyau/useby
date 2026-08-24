import AsyncStorage from '@react-native-async-storage/async-storage';
import { UseByItem } from '../../types';

const STORAGE_KEY = '@useby_v1_items';

/**
 * Envelope carries a version number so a future schema change can migrate
 * in place. since-fresh needed a migration module because it had shipped two
 * schema versions.
 *
 * Version 2 added the optional `dateType`. No migration step exists because
 * none is needed: a v1 record simply lacks the field and reads back as
 * `undefined`, which the UI presents as an unknown date type — accurate, since
 * those items were saved before we recorded what the pack said. The version is
 * bumped to record that the shape moved, not because anything rewrites it.
 */
const STORAGE_VERSION = 2;

interface Envelope {
  version: number;
  items: UseByItem[];
}

function isItem(value: unknown): value is UseByItem {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === 'string' &&
    typeof v.name === 'string' &&
    typeof v.expiryDate === 'string'
  );
}

export async function loadItems(): Promise<UseByItem[]> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Partial<Envelope>;
    if (!Array.isArray(parsed.items)) return [];
    return parsed.items.filter(isItem);
  } catch {
    return [];
  }
}

export async function saveItems(items: UseByItem[]): Promise<void> {
  const envelope: Envelope = { version: STORAGE_VERSION, items };
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(envelope));
}
