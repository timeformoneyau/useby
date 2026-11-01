/**
 * In-memory stand-ins for the two native modules the item service reaches.
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

export function install() {
  const stubs = {
    asyncStorage: createMemoryAsyncStorage(),
    fileSystem: createMemoryFileSystem(),
  };
  globalThis.__USEBY_STUBS__ = stubs;
  return stubs;
}
