import { DatabaseSync } from 'node:sqlite';

/**
 * Stand-ins for the three native modules the item service reaches.
 *
 * Installed on `globalThis.__USEBY_STUBS__` and picked up by the stub modules
 * in `app-loader.mjs`. Each test builds fresh ones with `install()`; the app
 * modules hold a reference to the stub object, not to its contents, so a
 * `reset()` between tests is enough to start clean.
 */

/** AsyncStorage, as far as `storage.ts` uses it, plus a write log. */
export function createMemoryAsyncStorage() {
  const data = new Map();
  const writes = [];
  return {
    data,
    writes,
    async getItem(key) {
      return data.has(key) ? data.get(key) : null;
    },
    async setItem(key, value) {
      writes.push({ key, value });
      data.set(key, value);
    },
    async removeItem(key) {
      data.delete(key);
    },
    reset() {
      data.clear();
      writes.length = 0;
    },
  };
}

/**
 * The slice of the `expo-file-system` (SDK 54 object API) that `photoStore.ts`
 * uses: `Paths.document`, `new Directory(...)`, `new File(...)`.
 *
 * Paths are plain strings joined with `/`; files are a Map of path → contents.
 * `onDelete` lets a test observe the moment a file goes, which is how the
 * storage-before-file ordering in `removeItem` is checked.
 */
export function createMemoryFileSystem() {
  const files = new Map();
  const dirs = new Set();
  const deleted = [];
  const hooks = { onDelete: null };

  const join = (parts) =>
    parts
      .map((p) => (typeof p === 'string' ? p : p.uri).replace(/\/+$/, ''))
      .join('/');

  class File {
    constructor(...parts) {
      this.uri = join(parts);
    }
    get name() {
      return this.uri.split('/').pop();
    }
    get exists() {
      return files.has(this.uri);
    }
    copy(dest) {
      if (!files.has(this.uri)) throw new Error(`ENOENT ${this.uri}`);
      files.set(dest.uri, files.get(this.uri));
    }
    delete() {
      if (!files.has(this.uri)) throw new Error(`ENOENT ${this.uri}`);
      hooks.onDelete?.(this.uri);
      files.delete(this.uri);
      deleted.push(this.uri);
    }
  }

  class Directory {
    constructor(...parts) {
      this.uri = join(parts);
    }
    create() {
      dirs.add(this.uri);
    }
    list() {
      const prefix = `${this.uri}/`;
      return [...files.keys()]
        .filter((p) => p.startsWith(prefix) && !p.slice(prefix.length).includes('/'))
        .map((p) => new File(p));
    }
  }

  return {
    files,
    dirs,
    deleted,
    hooks,
    File,
    Directory,
    Paths: { document: 'file:///doc', cache: 'file:///cache' },
    /** Put a file where a scan would have left it. */
    put(uri, contents = 'jpeg') {
      files.set(uri, contents);
    },
    reset() {
      files.clear();
      dirs.clear();
      deleted.length = 0;
      hooks.onDelete = null;
    },
  };
}

/**
 * `SqlDriver` over a real SQLite engine (`node:sqlite`), for tests that drive
 * `itemDatabase.ts` directly. `path` defaults to a private in-memory database;
 * pass a file path to test persistence across a close and reopen.
 *
 * `failOn(predicate)` makes the next matching statement throw, once, before it
 * runs — the way a full disk or a killed process looks to the caller. That is
 * how interrupted transactions and migrations are provoked.
 */
export function createNodeDriver(path = ':memory:') {
  const db = new DatabaseSync(path);
  const log = [];
  let failure = null;

  function check(sql) {
    log.push(sql);
    if (failure && failure.predicate(sql)) {
      const f = failure;
      if (!f.sticky) failure = null;
      throw new Error(f.message ?? `injected failure at: ${sql.trim().slice(0, 60)}`);
    }
  }

  return {
    db,
    log,
    failOn(predicate, { sticky = false, message } = {}) {
      failure = { predicate, sticky, message };
    },
    clearFailure() {
      failure = null;
    },
    close() {
      db.close();
    },
    async exec(sql) {
      check(sql);
      db.exec(sql);
    },
    async run(sql, params = []) {
      check(sql);
      const r = db.prepare(sql).run(...params);
      return { changes: Number(r.changes) };
    },
    async all(sql, params = []) {
      check(sql);
      return db.prepare(sql).all(...params);
    },
  };
}

/**
 * `expo-sqlite`, as far as `expoDriver.ts` uses it: `openDatabaseAsync(name)`
 * returning `execAsync` / `runAsync` / `getAllAsync`, over real SQLite.
 * Databases are kept by name, so a second open (a "restart") sees the same
 * data unless `reset()` is called. In-memory, so nothing touches disk.
 */
export function createNodeExpoSqlite() {
  const open = new Map();
  const state = { failNextOpen: false };
  return {
    open,
    state,
    async openDatabaseAsync(name) {
      if (state.failNextOpen) {
        state.failNextOpen = false;
        throw new Error('injected open failure');
      }
      if (!open.has(name)) open.set(name, new DatabaseSync(':memory:'));
      const db = open.get(name);
      return {
        async execAsync(sql) {
          db.exec(sql);
        },
        async runAsync(sql, params = []) {
          const r = db.prepare(sql).run(...params);
          return { changes: Number(r.changes), lastInsertRowId: Number(r.lastInsertRowid) };
        },
        async getAllAsync(sql, params = []) {
          return db.prepare(sql).all(...params);
        },
      };
    },
    /** The raw database behind `name`, for assertions. */
    raw(name = 'useby.db') {
      return open.get(name);
    },
    /**
     * Empty every table but keep the connection and the schema, because the
     * app's item database is opened once per process and holds on to it.
     */
    reset() {
      for (const db of open.values()) {
        const tables = db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
          .all();
        db.exec('PRAGMA foreign_keys = OFF');
        for (const { name } of tables) db.exec(`DELETE FROM "${name}"`);
        db.exec('PRAGMA foreign_keys = ON');
        const seq = db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'sqlite_sequence'").all();
        if (seq.length) db.exec('DELETE FROM sqlite_sequence');
      }
      state.failNextOpen = false;
    },
  };
}

export function install() {
  const stubs = {
    asyncStorage: createMemoryAsyncStorage(),
    fileSystem: createMemoryFileSystem(),
    sqlite: createNodeExpoSqlite(),
  };
  globalThis.__USEBY_STUBS__ = stubs;
  return stubs;
}
