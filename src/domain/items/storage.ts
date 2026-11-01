/**
 * Where items live: the app's one SQLite item database, opened on first use.
 *
 * Until this slice items were a single JSON envelope under one AsyncStorage key
 * (`@useby_v1_items`, envelope versions 1–4), rewritten whole on every change.
 * That envelope is now read exactly once, imported into SQLite inside one
 * verified transaction, and then left in place untouched — it is not deleted or
 * rewritten by this build. See `db/itemDatabase.ts` for the import and
 * `db/schema.ts` for the tables.
 *
 * Envelope history, kept because the import still reads every version of it:
 * v2 added the optional `dateType`, v3 the optional `photo`, v4 the optional
 * `dateUserSet`. None needed a migration: an older record simply lacks the
 * field, and the import carries the absence across as-is.
 *
 * The wiring only. Every decision is in `db/`, which the offline suite loads
 * directly.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { openExpoDriver } from './db/expoDriver';
import { createItemDatabase, type ItemDatabase, type LegacyImportReport } from './db/itemDatabase';

let database: Promise<ItemDatabase> | null = null;
let driver: ReturnType<typeof openExpoDriver> | null = null;

/**
 * One line per start-up, for device testing (`adb logcat -s ReactNativeJS |
 * grep useby.storage`). Counts and outcomes only — never an item name.
 */
function logImport(report: LegacyImportReport, fresh: boolean): void {
  if (!fresh) return;
  console.log(`useby.storage ${JSON.stringify({ stage: 'legacy-import', ...report })}`);
}

/** The opened, migrated item database. Retries from scratch if opening failed. */
export function itemDatabase(): Promise<ItemDatabase> {
  if (!database) {
    database = (async () => {
      // The connection is kept across a failed start-up; only the
      // migrate/import step is retried. Reopening would leak a connection.
      if (!driver) driver = openExpoDriver().catch((e: unknown) => ((driver = null), Promise.reject(e)));
      const db = createItemDatabase({
        driver: await driver,
        legacy: AsyncStorage,
        onLegacyImport: logImport,
      });
      await db.ready();
      return db;
    })().catch((error: unknown) => {
      database = null;
      console.log(
        `useby.storage ${JSON.stringify({ stage: 'open', outcome: 'failed', error: String(error) })}`,
      );
      throw error;
    });
  }
  return database;
}
