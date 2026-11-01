/**
 * Item record ↔ `items` row, losslessly.
 *
 * The rule is that an item read back is the item that was written: same keys,
 * same values, nothing added. That matters most for the legacy import, where
 * the input is whatever the AsyncStorage era stored — only `id`, `name` and
 * `expiryDate` were ever checked, so any other field may be missing or, in
 * principle, odd.
 *
 * - A known field with a value its column can hold goes in its column.
 * - A known field that is absent (or `null`) is stored as NULL and read back as
 *   absent — the AsyncStorage era treated the two the same, and every optional
 *   field on `UseByItem` is "absent means we do not know".
 * - Anything else — an unrecognised key, or a known key whose value does not fit
 *   its column — is kept verbatim in `extra` and merged back on read. Nothing is
 *   discarded because this schema did not anticipate it.
 */
import type { UseByItem } from '../../../types';

/** The `items` columns that describe the record (lifecycle columns excluded). */
export interface ItemRow {
  id: string;
  name: string;
  expiry_date: string;
  date_type: string | null;
  date_user_set: number | null;
  photo: string | null;
  source: string | null;
  created_at: string | null;
  updated_at: string | null;
  extra: string | null;
}

const DATE_TYPES = new Set(['use_by', 'best_before', 'unknown']);
const SOURCES = new Set(['manual', 'photo']);

type Rec = Record<string, unknown>;

function text(v: unknown): v is string {
  return typeof v === 'string';
}

export function itemToRow(item: UseByItem): ItemRow {
  const rec = item as unknown as Rec;
  const extra: Rec = {};
  const known = new Set([
    'id',
    'name',
    'expiryDate',
    'dateType',
    'dateUserSet',
    'photo',
    'source',
    'createdAt',
    'updatedAt',
  ]);

  for (const [key, value] of Object.entries(rec)) {
    if (!known.has(key) && value !== undefined) extra[key] = value;
  }

  /** Column value for a known optional field, or route it to `extra`. */
  function col<T>(key: string, fits: (v: unknown) => v is T): T | null {
    const v = rec[key];
    if (v === undefined || v === null) return null;
    if (fits(v)) return v;
    extra[key] = v;
    return null;
  }

  const dateType = col('dateType', (v): v is string => text(v) && DATE_TYPES.has(v));
  const source = col('source', (v): v is string => text(v) && SOURCES.has(v));
  const userSet = col('dateUserSet', (v): v is boolean => typeof v === 'boolean');

  return {
    id: item.id,
    name: item.name,
    expiry_date: item.expiryDate,
    date_type: dateType,
    date_user_set: userSet === null ? null : userSet ? 1 : 0,
    photo: col('photo', text),
    source,
    created_at: col('createdAt', text),
    updated_at: col('updatedAt', text),
    extra: Object.keys(extra).length > 0 ? JSON.stringify(extra) : null,
  };
}

export function rowToItem(row: ItemRow): UseByItem {
  let extra: Rec = {};
  if (row.extra) {
    try {
      const parsed = JSON.parse(row.extra) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) extra = parsed as Rec;
    } catch {
      // Unreadable extras cost the extras, never the item.
    }
  }

  const item: Rec = { ...extra, id: row.id, name: row.name, expiryDate: row.expiry_date };
  if (row.date_type !== null) item.dateType = row.date_type;
  if (row.date_user_set !== null) item.dateUserSet = row.date_user_set === 1;
  if (row.photo !== null) item.photo = row.photo;
  if (row.source !== null) item.source = row.source;
  if (row.created_at !== null) item.createdAt = row.created_at;
  if (row.updated_at !== null) item.updatedAt = row.updated_at;
  return item as unknown as UseByItem;
}

/** The record columns, in `ItemRow` order, for INSERT / SELECT. */
export const ITEM_COLUMNS = [
  'id',
  'name',
  'expiry_date',
  'date_type',
  'date_user_set',
  'photo',
  'source',
  'created_at',
  'updated_at',
  'extra',
] as const;

export function rowValues(row: ItemRow): (string | number | null)[] {
  return ITEM_COLUMNS.map((c) => row[c]);
}
