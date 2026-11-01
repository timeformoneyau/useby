/**
 * The app's SQLite driver: `expo-sqlite` behind the `SqlDriver` interface.
 *
 * Deliberately thin — one call per method — so everything that could be wrong
 * lives in `itemDatabase.ts`, which the offline suite runs against real SQLite.
 * The offline suite also loads this file, through `app-loader.mjs`, against a
 * `node:sqlite`-backed stand-in for `expo-sqlite`, so the adapter is exercised
 * too; the native module itself is a device-only check.
 *
 * One connection for the app's lifetime. `itemDatabase.ts` serialises every
 * operation on it, which is why `withTransactionAsync` (which does not stop
 * other calls interleaving) is not used: the database issues its own
 * `BEGIN IMMEDIATE` / `COMMIT` from inside its queue.
 */
import { openDatabaseAsync } from 'expo-sqlite';
import type { SqlDriver, SqlValue } from './driver.ts';

/** App-private, in expo-sqlite's default directory under the document dir. */
export const DATABASE_NAME = 'useby.db';

export async function openExpoDriver(name: string = DATABASE_NAME): Promise<SqlDriver> {
  const db = await openDatabaseAsync(name);
  // WAL: a crash mid-write cannot corrupt committed data, and readers do not
  // block the writer. Set once per connection; persists in the file.
  await db.execAsync('PRAGMA journal_mode = WAL');

  return {
    exec: (sql) => db.execAsync(sql),
    run: async (sql, params: readonly SqlValue[] = []) => {
      const result = await db.runAsync(sql, [...params]);
      return { changes: result.changes };
    },
    all: <T>(sql: string, params: readonly SqlValue[] = []) => db.getAllAsync<T>(sql, [...params]),
  };
}
