import AsyncStorage from '@react-native-async-storage/async-storage';
import { UseByItem } from '../../types';

const STORAGE_KEY = '@useby_v1_items';

/**
 * Envelope carries a version number so a future schema change can migrate
 * in place. since-fresh needed a migration module because it had shipped two
 * schema versions; UseBy starts at 1 with nothing to migrate from.
 */
const STORAGE_VERSION = 1;

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
