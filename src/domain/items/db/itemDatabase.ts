/**
 * The local item database: SQLite, transactional, one writer at a time.
 *
 * Replaces the AsyncStorage envelope, whose every mutation was load the whole
 * array → change it → save the whole array. Two of those overlapping lost one
 * of the writes (pinned by a test in `item-lifecycle.test.mjs`). Here:
 *
 * 1. **Every operation runs through one serial queue.** Reads included, so a
 *    read can never observe another operation's half-finished transaction on
 *    the shared connection.
 * 2. **Every mutation is one transaction** (`BEGIN IMMEDIATE … COMMIT`) that
 *    re-reads the row it changes, writes it, and records the mutation, its
 *    lifecycle event and its outbox entry. Either all of that lands or none of
 *    it does; a failure anywhere rolls the whole thing back.
 * 3. **Every mutation carries a client-generated id**, and a mutation whose id
 *    is already recorded is not applied again. A retried or duplicated call is
 *    harmless, and the id is the idempotency key a future sync will send.
 *
 * No value imports beyond sibling pure modules, so the offline suite loads this
 * under Node's type stripping and runs it against real SQLite (`node:sqlite`).
 * The app wiring — which driver, which AsyncStorage — is `storage.ts`.
 */
import type { UseByItem } from '../../../types';
import type { SqlDriver, SqlValue } from './driver.ts';
import { MIGRATIONS, SCHEMA_VERSION } from './schema.ts';
import { ITEM_COLUMNS, itemToRow, rowToItem, rowValues, type ItemRow } from './rows.ts';
import { LEGACY_ITEMS_KEY, parseLegacyEnvelope, type LegacyKv } from './legacy.ts';

export type ItemStatusValue = 'active' | 'used' | 'wasted' | 'deleted';
/** How an item leaves the list. Both remove it from Home; only the record differs. */
export type RemovalReason = 'used' | 'deleted';

type MutationKind = 'create' | 'edit' | 'use' | 'delete' | 'import';
type EventKind = 'created' | 'edited' | 'used' | 'deleted' | 'imported';

/** What the one-time AsyncStorage import found and did. Stored in `meta`. */
export interface LegacyImportReport {
  outcome: 'absent' | 'unreadable' | 'imported';
  envelopeVersion: number | null;
  imported: number;
  /** Already present in SQLite by id, so left as SQLite has it. */
  alreadyPresent: number;
  invalid: number;
  duplicates: number;
  at: string;
}

export interface ItemDatabaseOptions {
  driver: SqlDriver;
  /** AsyncStorage, for the one-time import. Omit to skip the import entirely. */
  legacy?: LegacyKv;
  /** ISO timestamp source. Injected so tests are deterministic. */
  now?: () => string;
  /** Called once per start-up with the import outcome, for diagnostics. */
  onLegacyImport?: (report: LegacyImportReport, fresh: boolean) => void;
}

export interface ItemDatabase {
  /** Open, migrate and import. Idempotent; every other method awaits it. */
  ready(): Promise<void>;
  /** Active items, in the order they were added. */
  listActive(): Promise<UseByItem[]>;
  /** One active item, or `null`. */
  getActive(id: string): Promise<UseByItem | null>;
  /** Insert a new item. Replaying the same `mutationId` returns it unchanged. */
  create(item: UseByItem, mutationId: string): Promise<UseByItem>;
  /**
   * Change an active item. `change` sees the row as it is *inside* the
   * transaction — never a stale copy — and returns the new record, or `null`
   * for "nothing to change", which writes nothing.
   *
   * Returns `{ item: null }` when there is no active item with that id.
   */
  update(
    id: string,
    change: (current: UseByItem) => UseByItem | null,
    mutationId: string,
  ): Promise<{ item: UseByItem | null; changed: boolean }>;
  /**
   * Take an item off the list as Used or Deleted. The row stays, with its
   * status changed and its photo reference cleared; the removed record is
   * returned so the caller can delete the file *after* the commit.
   * `null` if it was not active (already gone, or a replay).
   */
  remove(id: string, reason: RemovalReason, mutationId: string): Promise<UseByItem | null>;
  /** Every photo filename any row still names, for the start-up sweep. */
  referencedPhotos(): Promise<string[]>;
}

const SELECT_ITEM = `SELECT ${ITEM_COLUMNS.join(', ')}, status, revision FROM items`;
const INSERT_ITEM = `INSERT INTO items (${ITEM_COLUMNS.join(', ')}) VALUES (${ITEM_COLUMNS.map(() => '?').join(', ')})`;

const INSERT_ITEM_OR_IGNORE = INSERT_ITEM.replace('INSERT INTO', 'INSERT OR IGNORE INTO');

type FullRow = ItemRow & { status: ItemStatusValue; revision: number };

export function createItemDatabase(options: ItemDatabaseOptions): ItemDatabase {
  const { driver, legacy } = options;
  const now = options.now ?? (() => new Date().toISOString());

  /* ---------- one at a time ---------- */

  let tail: Promise<unknown> = Promise.resolve();
  function serial<T>(task: () => Promise<T>): Promise<T> {
    const result = tail.then(task, task);
    tail = result.catch(() => {});
    return result;
  }

  async function transaction<T>(task: () => Promise<T>): Promise<T> {
    await driver.exec('BEGIN IMMEDIATE');
    try {
      const result = await task();
      await driver.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        await driver.exec('ROLLBACK');
      } catch {
        // Nothing to roll back (the failure was BEGIN itself), or the
        // connection is gone — in which case SQLite discards the open
        // transaction anyway. Either way the original error is the one to see.
      }
      throw error;
    }
  }

  /* ---------- small helpers, all inside a transaction ---------- */

  async function readRow(id: string): Promise<FullRow | null> {
    const rows = await driver.all<FullRow>(`${SELECT_ITEM} WHERE id = ?`, [id]);
    return rows[0] ?? null;
  }

  async function mutationSeen(mutationId: string): Promise<boolean> {
    const rows = await driver.all<{ one: number }>('SELECT 1 AS one FROM mutations WHERE id = ?', [
      mutationId,
    ]);
    return rows.length > 0;
  }

  async function record(m: {
    id: string;
    itemId: string;
    kind: MutationKind;
    payload: unknown;
    baseRevision: number | null;
    event: EventKind;
    fromStatus: ItemStatusValue | null;
    toStatus: ItemStatusValue;
    at: string;
  }): Promise<void> {
    await driver.run(
      'INSERT INTO mutations (id, item_id, kind, payload, base_revision, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [m.id, m.itemId, m.kind, JSON.stringify(m.payload), m.baseRevision, m.at],
    );
    await driver.run(
      'INSERT INTO item_events (item_id, mutation_id, kind, from_status, to_status, at) VALUES (?, ?, ?, ?, ?, ?)',
      [m.itemId, m.id, m.event, m.fromStatus, m.toStatus, m.at],
    );
    await driver.run('INSERT INTO sync_outbox (mutation_id, enqueued_at) VALUES (?, ?)', [
      m.id,
      m.at,
    ]);
  }

  async function getMeta(key: string): Promise<string | null> {
    const rows = await driver.all<{ value: string }>('SELECT value FROM meta WHERE key = ?', [key]);
    return rows[0]?.value ?? null;
  }

  async function setMeta(key: string, value: string): Promise<void> {
    await driver.run(
      'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
      [key, value],
    );
  }

  /* ---------- start-up ---------- */

  async function migrateSchema(): Promise<void> {
    await driver.exec('PRAGMA foreign_keys = ON');
    const rows = await driver.all<{ user_version: number }>('PRAGMA user_version');
    const current = rows[0]?.user_version ?? 0;

    // A database written by a newer build. Refuse rather than guess: writing to
    // a schema this build does not know is how records get corrupted.
    if (current > SCHEMA_VERSION) {
      throw new Error(`item database is schema ${current}; this build knows ${SCHEMA_VERSION}`);
    }

    for (const migration of MIGRATIONS) {
      if (migration.version <= current) continue;
      await transaction(async () => {
        await driver.exec(migration.sql);
        // user_version lives in the database header and commits — or rolls
        // back — with the transaction, so "applied" and "recorded" cannot
        // disagree.
        await driver.exec(`PRAGMA user_version = ${migration.version}`);
      });
    }
  }

  /**
   * The one-time copy from AsyncStorage. Never deletes or rewrites the
   * AsyncStorage key: in this slice it is left exactly as it was, as a second
   * copy, and SQLite simply stops reading it once `legacy_import` is recorded.
   *
   * All of it — snapshot, rows, mutations, events, outbox, the completion
   * marker — is one transaction, verified before commit. An interruption at any
   * point leaves no partial import and no marker, so the next start-up does the
   * whole thing again from the untouched source.
   */
  async function importLegacy(): Promise<void> {
    if (!legacy) return;

    const done = await getMeta('legacy_import');
    if (done !== null) {
      options.onLegacyImport?.(JSON.parse(done) as LegacyImportReport, false);
      return;
    }

    // Outside the transaction: an AsyncStorage read is not SQLite work, and a
    // failure here must leave the database untouched (it does — nothing has
    // been written) and be retried next time (it will — no marker).
    const raw = await legacy.getItem(LEGACY_ITEMS_KEY);
    const parsed = parseLegacyEnvelope(raw);
    const at = now();

    const report = await transaction(async () => {
      // Re-check inside the lock: belt and braces against a second opener.
      if ((await getMeta('legacy_import')) !== null) return null;

      if (raw !== null) {
        await driver.run(
          'INSERT OR IGNORE INTO legacy_snapshot (key, raw, taken_at) VALUES (?, ?, ?)',
          [LEGACY_ITEMS_KEY, raw, at],
        );
      }

      const result: LegacyImportReport = {
        outcome: parsed.outcome === 'parsed' ? 'imported' : parsed.outcome,
        envelopeVersion: parsed.outcome === 'parsed' ? parsed.envelopeVersion : null,
        imported: 0,
        alreadyPresent: 0,
        invalid: parsed.outcome === 'parsed' ? parsed.invalid : 0,
        duplicates: parsed.outcome === 'parsed' ? parsed.duplicates : 0,
        at,
      };

      if (parsed.outcome === 'parsed') {
        const inserted = new Set<string>();
        for (const item of parsed.items) {
          const row = itemToRow(item);
          const written = await driver.run(INSERT_ITEM_OR_IGNORE, rowValues(row));
          if (written.changes === 0) {
            // SQLite already has this id. SQLite is the newer truth; leave it.
            result.alreadyPresent += 1;
            continue;
          }
          result.imported += 1;
          inserted.add(item.id);
          await record({
            id: `import:${item.id}`,
            itemId: item.id,
            kind: 'import',
            payload: item,
            baseRevision: null,
            event: 'imported',
            fromStatus: null,
            toStatus: 'active',
            at,
          });
        }

        // Verify before commit: every item the old reader would have shown is
        // now readable back, field for field. Anything else aborts the import.
        for (const item of parsed.items) {
          const back = await readRow(item.id);
          if (!back) throw new Error(`legacy import verification: ${item.id} missing`);
          const expected = JSON.stringify(sortKeys(itemToRow(item)));
          const actual = JSON.stringify(sortKeys(pickRecord(back)));
          if (inserted.has(item.id) && expected !== actual) {
            throw new Error(`legacy import verification: ${item.id} differs`);
          }
        }
      }

      await setMeta('legacy_import', JSON.stringify(result));
      return result;
    });

    if (report) options.onLegacyImport?.(report, true);
  }

  let opening: Promise<void> | null = null;
  function ready(): Promise<void> {
    if (!opening) {
      opening = serial(async () => {
        await migrateSchema();
        await importLegacy();
      }).catch((error: unknown) => {
        // Not memoised as a failure: the next call tries again from scratch,
        // which is safe because every step above is idempotent.
        opening = null;
        throw error;
      });
    }
    return opening;
  }

  async function op<T>(task: () => Promise<T>): Promise<T> {
    await ready();
    return serial(task);
  }

  /* ---------- the operations ---------- */

  return {
    ready,

    listActive: () =>
      op(async () => {
        const rows = await driver.all<FullRow>(`${SELECT_ITEM} WHERE status = 'active' ORDER BY rowid`);
        return rows.map(rowToItem);
      }),

    getActive: (id) =>
      op(async () => {
        const rows = await driver.all<FullRow>(`${SELECT_ITEM} WHERE id = ? AND status = 'active'`, [
          id,
        ]);
        return rows[0] ? rowToItem(rows[0]) : null;
      }),

    create: (item, mutationId) =>
      op(() =>
        transaction(async () => {
          if (await mutationSeen(mutationId)) {
            const existing = await readRow(item.id);
            if (existing) return rowToItem(existing);
          }
          await driver.run(INSERT_ITEM, rowValues(itemToRow(item)));
          await record({
            id: mutationId,
            itemId: item.id,
            kind: 'create',
            payload: item,
            baseRevision: null,
            event: 'created',
            fromStatus: null,
            toStatus: 'active',
            at: item.createdAt ?? now(),
          });
          return item;
        }),
      ),

    update: (id, change, mutationId) =>
      op(() =>
        transaction(async () => {
          const row = await readRow(id);
          if (!row || row.status !== 'active') return { item: null, changed: false };
          const current = rowToItem(row);
          if (await mutationSeen(mutationId)) return { item: current, changed: false };

          const next = change(current);
          if (next === null) return { item: current, changed: false };
          if (next.id !== id) throw new Error('an update cannot change an item id');

          const values = rowValues(itemToRow(next));
          const sets = ITEM_COLUMNS.slice(1)
            .map((c) => `${c} = ?`)
            .join(', ');
          await driver.run(`UPDATE items SET ${sets}, revision = revision + 1 WHERE id = ?`, [
            ...values.slice(1),
            id,
          ]);
          await record({
            id: mutationId,
            itemId: id,
            kind: 'edit',
            payload: next,
            baseRevision: row.revision,
            event: 'edited',
            fromStatus: 'active',
            toStatus: 'active',
            at: next.updatedAt ?? now(),
          });
          return { item: next, changed: true };
        }),
      ),

    remove: (id, reason, mutationId) =>
      op(() =>
        transaction(async () => {
          if (await mutationSeen(mutationId)) return null;
          const row = await readRow(id);
          if (!row || row.status !== 'active') return null;

          const to: ItemStatusValue = reason === 'used' ? 'used' : 'deleted';
          const at = now();
          // The photo reference goes with the status change, in the same
          // commit: the file is about to be deleted, and a row naming a file
          // that is gone is the one state worth more effort to avoid than an
          // orphan file (which the start-up sweep collects).
          await driver.run(
            'UPDATE items SET status = ?, status_changed_at = ?, photo = NULL, revision = revision + 1 WHERE id = ?',
            [to, at, id],
          );
          await record({
            id: mutationId,
            itemId: id,
            kind: reason === 'used' ? 'use' : 'delete',
            payload: { status: to, photo: row.photo },
            baseRevision: row.revision,
            event: to === 'used' ? 'used' : 'deleted',
            fromStatus: 'active',
            toStatus: to,
            at,
          });
          return rowToItem(row);
        }),
      ),

    referencedPhotos: () =>
      op(async () => {
        const rows = await driver.all<{ photo: string }>(
          'SELECT photo FROM items WHERE photo IS NOT NULL',
        );
        return rows.map((r) => r.photo);
      }),
  };
}

function pickRecord(row: FullRow): ItemRow {
  const out: Record<string, SqlValue> = {};
  for (const c of ITEM_COLUMNS) out[c] = row[c];
  return out as unknown as ItemRow;
}

function sortKeys(row: ItemRow): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).sort(([a], [b]) => a.localeCompare(b)));
}
