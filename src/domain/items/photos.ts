/**
 * The durable photo store: who owns a scan image once it stops being a draft.
 *
 * There are two image lifetimes in this app and confusing them is the whole
 * class of bug this module exists to prevent:
 *
 * - **A pending scan owns a temporary image.** It lives in the cache directory
 *   where `manipulateAsync` wrote it, the queue holds it, and the queue deletes
 *   it when the draft is saved, discarded or retaken. That half is `pending.ts`
 *   and is unchanged.
 * - **A saved item owns a durable image.** It lives in the document directory,
 *   the item record names it, and `removeItem` deletes it. That is this module.
 *
 * The handover is Save, and it goes one way: copy into durable storage, write
 * the item, and only then let the queue release the temporary file. Nothing
 * else moves an image between the two worlds.
 *
 * Deliberately a factory over an injected filesystem rather than a module that
 * imports `expo-file-system` directly. Same reason `pending.ts` is a factory
 * over an injected runner: this file has no value imports, so Node's type
 * stripping can load it and the offline suite can exercise the whole lifecycle —
 * including the failure paths, which are the ones that matter and which cannot
 * be provoked against a real filesystem. The wiring lives in `photoStore.ts`.
 */

/**
 * What a filesystem has to do for us. Six operations, all in terms of
 * filenames — the directory is the adapter's business, not this module's.
 *
 * `copy` and `delete` may throw; every caller here is written on the assumption
 * that they will.
 */
export interface PhotoFs {
  /** Create the photos directory if it is not already there. Idempotent. */
  ensureDir(): void;
  /** Copy an arbitrary source URI to `filename` inside the photos directory. */
  copy(sourceUri: string, filename: string): void;
  delete(filename: string): void;
  exists(filename: string): boolean;
  /** Every filename directly inside the photos directory. */
  list(): string[];
  /** Absolute URI for a stored filename, for rendering. */
  uriFor(filename: string): string;
}

export interface PhotoStore {
  /**
   * Copy a pending scan's image into durable storage.
   *
   * Returns the filename to store on the item, or `null` if anything at all
   * went wrong. Never throws: losing a photo is a minor degradation and
   * failing a save because of one would be absurd.
   */
  retain(scanId: string, sourceUri: string): string | null;
  /** Absolute URI for an item's stored photo, or `null` if it has none. */
  uriFor(filename: string | undefined): string | null;
  /** Delete an item's photo. Best effort; a failure leaves work for the sweep. */
  remove(filename: string | undefined): void;
  /**
   * Delete every stored photo no saved item refers to.
   *
   * Returns how many were removed, which is only interesting to a test and a
   * log line.
   */
  sweep(referenced: readonly (string | undefined)[]): number;
}

const PREFIX = 'scan-';
const EXTENSION = '.jpg';

/**
 * Scan ids we are willing to build a filename from.
 *
 * The same character set `isScanId` enforces on the wire, applied again here
 * because this one is concatenated into a path. Ids are minted locally so a
 * traversal sequence is not a realistic attack, but a filename is exactly the
 * wrong place to find that assumption was wrong, and the check is free.
 */
const SAFE_SCAN_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** The stored filename for a scan, or `null` if the id is not one we minted. */
export function photoFilename(scanId: string): string | null {
  if (!SAFE_SCAN_ID.test(scanId)) return null;
  return `${PREFIX}${scanId}${EXTENSION}`;
}

/**
 * True for a filename this module could have written.
 *
 * The sweep deletes what nothing refers to, so it is bounded to our own files.
 * Anything else in that directory belongs to something we do not know about,
 * and deleting it because we did not recognise it would be the sweep causing
 * exactly the kind of damage it exists to prevent.
 */
export function isPhotoFilename(name: string): boolean {
  return (
    name.startsWith(PREFIX) &&
    name.endsWith(EXTENSION) &&
    SAFE_SCAN_ID.test(name.slice(PREFIX.length, -EXTENSION.length))
  );
}

/**
 * Which stored files no item refers to any more.
 *
 * Pure, and separated from the deleting so the decision can be tested without
 * a filesystem. Undefined entries in `referenced` are the ordinary case — most
 * items have no photo — and are skipped rather than treated as a name.
 */
export function orphanPhotos(
  stored: readonly string[],
  referenced: readonly (string | undefined)[],
): string[] {
  const keep = new Set(referenced.filter((name): name is string => Boolean(name)));
  return stored.filter((name) => isPhotoFilename(name) && !keep.has(name));
}

export function createPhotoStore(fs: PhotoFs): PhotoStore {
  return {
    retain(scanId, sourceUri) {
      const filename = photoFilename(scanId);
      if (filename === null) return null;

      try {
        fs.ensureDir();

        // The destination can already exist: the same scan is retried after a
        // failed write, or a filename is reused after a crash mid-save. Copying
        // onto an existing file is not reliably an overwrite, so clear the way
        // first. A failure here is not fatal — the copy below decides.
        if (fs.exists(filename)) {
          try {
            fs.delete(filename);
          } catch {
            // Fall through; the copy will fail if this really mattered.
          }
        }

        fs.copy(sourceUri, filename);

        // Copy reported success. Confirm the file is actually there before
        // handing back a name the item will be stored with — a name pointing at
        // nothing is the one outcome worth more than a missing photo, because it
        // is invisible until someone opens the item weeks later.
        return fs.exists(filename) ? filename : null;
      } catch {
        return null;
      }
    },

    uriFor(filename) {
      if (!filename || !isPhotoFilename(filename)) return null;
      return fs.uriFor(filename);
    },

    remove(filename) {
      if (!filename || !isPhotoFilename(filename)) return;
      try {
        if (fs.exists(filename)) fs.delete(filename);
      } catch {
        // Best effort by design. The item record is already gone, so the file
        // is now an orphan and the next sweep collects it. Surfacing this to
        // someone who just tapped "Used it" would be noise about nothing.
      }
    },

    sweep(referenced) {
      let removed = 0;

      try {
        const orphans = orphanPhotos(fs.list(), referenced);
        for (const name of orphans) {
          try {
            fs.delete(name);
            removed += 1;
          } catch {
            // Leave it for next time.
          }
        }
      } catch {
        // The directory may not exist yet — the ordinary state before the first
        // photo is ever saved. Nothing to sweep is not a failure.
      }

      return removed;
    },
  };
}
