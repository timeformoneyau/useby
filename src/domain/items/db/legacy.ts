/**
 * Reading the AsyncStorage-era item envelope, for the one-time import into
 * SQLite.
 *
 * Pure: this decides what the old data *says*; `itemDatabase.ts` decides what to
 * do about it, inside a transaction.
 *
 * The AsyncStorage era wrote `{ version, items }` under one key and, on read,
 * kept any element with a string `id`, `name` and `expiryDate`, silently
 * skipping the rest. The import accepts exactly what that reader accepted, so
 * nothing the user could see before is missing after — and nothing they could
 * not see is resurrected. The skipped elements are not thrown away either: the
 * raw envelope is preserved verbatim in `legacy_snapshot`.
 */
import type { UseByItem } from '../../../types';

/** The AsyncStorage key every build up to envelope v4 wrote items under. */
export const LEGACY_ITEMS_KEY = '@useby_v1_items';

/** What the importer needs from AsyncStorage. Read only: it never writes or removes. */
export interface LegacyKv {
  getItem(key: string): Promise<string | null>;
}

export type LegacyParse =
  /** No key at all: a fresh install, or a phone that never saved an item. */
  | { outcome: 'absent' }
  /**
   * Present but not an envelope the old reader could use (bad JSON, no
   * `items` array). The old app showed an empty list for this, so the import
   * imports nothing — but the raw value is snapshotted, never discarded.
   */
  | { outcome: 'unreadable' }
  | {
      outcome: 'parsed';
      envelopeVersion: number | null;
      /** Valid items, first occurrence of each id, in stored order. */
      items: UseByItem[];
      /** Elements the old reader also skipped. Preserved in the snapshot. */
      invalid: number;
      /** Later elements repeating an id already seen. Preserved in the snapshot. */
      duplicates: number;
    };

/** The same test the AsyncStorage-era `loadItems` applied. */
export function isLegacyItem(value: unknown): value is UseByItem {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.id === 'string' && typeof v.name === 'string' && typeof v.expiryDate === 'string';
}

export function parseLegacyEnvelope(raw: string | null): LegacyParse {
  if (raw === null) return { outcome: 'absent' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { outcome: 'unreadable' };
  }
  if (typeof parsed !== 'object' || parsed === null) return { outcome: 'unreadable' };
  const env = parsed as { version?: unknown; items?: unknown };
  if (!Array.isArray(env.items)) return { outcome: 'unreadable' };

  const seen = new Set<string>();
  const items: UseByItem[] = [];
  let invalid = 0;
  let duplicates = 0;

  for (const element of env.items) {
    if (!isLegacyItem(element)) {
      invalid += 1;
    } else if (seen.has(element.id)) {
      // The old `getDerivedItem` returned the first match, and Used / Delete
      // filtered every copy out. First wins is the reading the user saw.
      duplicates += 1;
    } else {
      seen.add(element.id);
      items.push(element);
    }
  }

  return {
    outcome: 'parsed',
    envelopeVersion: typeof env.version === 'number' ? env.version : null,
    items,
    invalid,
    duplicates,
  };
}
