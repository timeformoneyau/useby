/**
 * The slice of SQLite the item database needs, as an injected interface.
 *
 * Same reason `photos.ts` takes a `PhotoFs`: everything that decides anything
 * — the schema, the transactions, the legacy import — lives in modules with no
 * value imports, so the offline suite loads them under Node's type stripping
 * and runs them against a **real** SQLite engine (`node:sqlite`), not a mock of
 * one. Transactions, constraints and rollback are then the engine's behaviour,
 * not a fake's. The app's adapter over `expo-sqlite` is `expoDriver.ts`.
 *
 * Three operations, all promise-returning because the native driver is.
 */

/** Values SQLite can bind. Booleans are not among them — store 0 / 1. */
export type SqlValue = string | number | null;

export interface SqlDriver {
  /** Run one or more statements with no parameters and no result. */
  exec(sql: string): Promise<void>;
  /** Run one statement. `changes` is the number of rows it wrote. */
  run(sql: string, params?: readonly SqlValue[]): Promise<{ changes: number }>;
  /** Run one query and return every row as a plain object. */
  all<T>(sql: string, params?: readonly SqlValue[]): Promise<T[]>;
}
