/**
 * The item database schema, as an ordered list of migrations.
 *
 * `PRAGMA user_version` records how many have been applied. Each migration runs
 * inside the same transaction as the `user_version` bump that records it, so a
 * migration is either wholly applied and recorded or not applied at all — an
 * interrupted start-up re-runs it from the beginning on the next launch.
 *
 * **Append only.** A shipped migration is never edited: a phone that already
 * ran it will not run it again, so editing it would make two phones with the
 * same `user_version` hold different schemas.
 *
 * ## The four record kinds
 *
 * - `items` — the current state of each item, one row per item **for its whole
 *   life**. Used and Delete change `status`; neither removes the row. Home lists
 *   `status = 'active'` only, so what the user sees is unchanged, but the
 *   difference between "eaten" and "added by mistake" is now recorded instead
 *   of thrown away, and a later sync has a tombstone to propagate.
 * - `mutations` — one row per change a person (or the legacy import) made, keyed
 *   by a client-generated id. The id is the idempotency key: a mutation applied
 *   twice is applied once. This is the shape the verified backend's item RPCs
 *   take (`client_mutation_id`), so the record that will be sent already exists.
 * - `item_events` — the lifecycle history: created, edited, used, deleted,
 *   imported. One per mutation, written in the same transaction as the item row.
 * - `sync_outbox` — mutations waiting to reach a server. **Nothing reads it yet**
 *   — there is no backend connection in this slice — but every mutation is
 *   enqueued in the same transaction that applies it, so when sync arrives it
 *   starts from a complete, ordered queue rather than a reconstruction.
 *
 * Plus `meta` (small key/value facts such as the legacy import outcome) and
 * `legacy_snapshot` (the AsyncStorage envelope exactly as it was found, kept
 * so the migration can never be the reason a record is lost).
 *
 * ## Column choices
 *
 * Item columns are nullable wherever a legacy record could lack the field. The
 * AsyncStorage era only ever checked `id`, `name` and `expiryDate`, so anything
 * else may be missing on an old record, and the honest import is to carry the
 * absence across rather than invent a value. `extra` holds, as JSON, any field
 * a legacy record carried that has no column — nothing is dropped because this
 * schema did not anticipate it.
 *
 * `revision` counts changes to the row, and each mutation records the revision
 * it was based on. Sync will need both; recording them now costs nothing.
 */

export interface Migration {
  /** The `user_version` this migration brings the database to. */
  version: number;
  sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE items (
        id                 TEXT PRIMARY KEY NOT NULL,
        name               TEXT NOT NULL,
        expiry_date        TEXT NOT NULL,
        date_type          TEXT,
        date_user_set      INTEGER,
        photo              TEXT,
        source             TEXT,
        created_at         TEXT,
        updated_at         TEXT,
        extra              TEXT,
        status             TEXT NOT NULL DEFAULT 'active'
                           CHECK (status IN ('active', 'used', 'wasted', 'deleted')),
        status_changed_at  TEXT,
        revision           INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX items_status ON items (status);

      CREATE TABLE mutations (
        id             TEXT PRIMARY KEY NOT NULL,
        item_id        TEXT NOT NULL,
        kind           TEXT NOT NULL
                       CHECK (kind IN ('create', 'edit', 'use', 'delete', 'import')),
        payload        TEXT NOT NULL,
        base_revision  INTEGER,
        created_at     TEXT NOT NULL
      );
      CREATE INDEX mutations_item ON mutations (item_id);

      CREATE TABLE item_events (
        seq          INTEGER PRIMARY KEY AUTOINCREMENT,
        item_id      TEXT NOT NULL,
        mutation_id  TEXT NOT NULL UNIQUE REFERENCES mutations (id),
        kind         TEXT NOT NULL
                     CHECK (kind IN ('created', 'edited', 'used', 'deleted', 'imported')),
        from_status  TEXT,
        to_status    TEXT NOT NULL,
        at           TEXT NOT NULL
      );
      CREATE INDEX item_events_item ON item_events (item_id);

      CREATE TABLE sync_outbox (
        seq              INTEGER PRIMARY KEY AUTOINCREMENT,
        mutation_id      TEXT NOT NULL UNIQUE REFERENCES mutations (id),
        state            TEXT NOT NULL DEFAULT 'pending'
                         CHECK (state IN ('pending', 'sent', 'failed')),
        attempts         INTEGER NOT NULL DEFAULT 0,
        last_attempt_at  TEXT,
        last_error       TEXT,
        enqueued_at      TEXT NOT NULL
      );

      CREATE TABLE meta (
        key    TEXT PRIMARY KEY NOT NULL,
        value  TEXT NOT NULL
      );

      CREATE TABLE legacy_snapshot (
        key        TEXT PRIMARY KEY NOT NULL,
        raw        TEXT NOT NULL,
        taken_at   TEXT NOT NULL
      );
    `,
  },
];

export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;
