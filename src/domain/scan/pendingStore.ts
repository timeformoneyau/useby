/**
 * The pending-scan queue's durable half: `PendingScan` ↔ `pending_scans` row.
 *
 * Pure (type imports only), so the offline suite runs the real queue against
 * the real SQLite item database through exactly this adapter. The app wiring —
 * which directory, which filesystem — is `queue.ts`.
 *
 * Two rules:
 *
 * - **Photos are stored as filenames**, resolved against the pending-photos
 *   directory on the way back, never as absolute URIs (an app container path
 *   can change between installs). A URI outside that directory — a cache file
 *   the capture could not move — is not persisted at all: after a restart it
 *   would point at a file the OS may already have reclaimed.
 * - **Writes are applied in the order they were issued.** Each one waits for
 *   the previous one, so a `put` followed by a `remove` can never land the
 *   other way round. The database serialises too; this makes the order hold
 *   even across a database open that had to be retried.
 */
import type { PendingScanRow } from '../items/db/itemDatabase';
import type { PendingScan, PendingStatus, PendingStore } from './pending';

/** The only filenames the pending directory may hold, and the only ones swept. */
export const PENDING_FILE = /^pending-[A-Za-z0-9_-]{1,64}\.jpg$/;

export function pendingFilename(scanId: string): string | null {
  const name = `pending-${scanId}.jpg`;
  return PENDING_FILE.test(name) ? name : null;
}

/**
 * Pending photos no draft refers to, from a directory listing.
 *
 * Bounded to our own naming pattern, so a file we did not write is never
 * deleted for being unrecognised. Run only after `restore`, against what the
 * queue then holds.
 */
export function orphanPendingFiles(
  listed: readonly string[],
  scans: readonly PendingScan[],
  files: PendingFiles,
): string[] {
  const keep = new Set(
    scans
      .map((scan) => (scan.imageUri ? files.fileOf(scan.imageUri) : null))
      .filter((name): name is string => name !== null),
  );
  return listed.filter((name) => PENDING_FILE.test(name) && !keep.has(name));
}

export interface PendingRowsDb {
  listPendingScans(): Promise<PendingScanRow[]>;
  putPendingScan(row: PendingScanRow): Promise<void>;
  deletePendingScan(scanId: string): Promise<void>;
  replacePendingScan(previousScanId: string, row: PendingScanRow): Promise<void>;
}

export interface PendingFiles {
  /** Filename to persist for an image URI, or null if it is not one of ours. */
  fileOf(imageUri: string): string | null;
  /** URI for a persisted filename, or null if the file is no longer there. */
  uriOf(filename: string): string | null;
}

const STATUSES: ReadonlySet<PendingStatus> = new Set([
  'queued',
  'active',
  'ready',
  'failed',
  'interrupted',
]);

export function scanToRow(scan: PendingScan, files: PendingFiles): PendingScanRow {
  return {
    scan_id: scan.scanId,
    status: scan.status,
    shutter_at: scan.shutterAt,
    settled_at: scan.settledAt ?? null,
    image_file: scan.imageUri ? files.fileOf(scan.imageUri) : null,
    prefill: scan.prefill ? JSON.stringify(scan.prefill) : null,
    trust: scan.trust ? JSON.stringify(scan.trust) : null,
  };
}

function parse<T>(json: string | null): T | undefined {
  if (!json) return undefined;
  try {
    const value = JSON.parse(json) as unknown;
    return value && typeof value === 'object' ? (value as T) : undefined;
  } catch {
    // An unreadable result costs the result, never the draft: without a
    // prefill it opens the editor as an unreadable scan, photo and all.
    return undefined;
  }
}

/** A stored row as a draft, or null for a row too damaged to be one. */
export function rowToScan(row: PendingScanRow, files: PendingFiles): PendingScan | null {
  if (typeof row.scan_id !== 'string' || !STATUSES.has(row.status)) return null;
  const imageUri = row.image_file ? files.uriOf(row.image_file) : null;
  const prefill = parse<PendingScan['prefill']>(row.prefill);
  const trust = parse<PendingScan['trust']>(row.trust);
  return {
    scanId: row.scan_id,
    status: row.status,
    shutterAt: Number(row.shutter_at),
    ...(row.settled_at !== null ? { settledAt: Number(row.settled_at) } : {}),
    ...(imageUri ? { imageUri } : {}),
    ...(prefill ? { prefill } : {}),
    ...(trust ? { trust } : {}),
  };
}

export interface DurablePendingStore extends PendingStore {
  /** Every persisted draft, as drafts. */
  load(): Promise<PendingScan[]>;
  /** Resolves once every write issued so far has been applied (or failed). */
  idle(): Promise<void>;
}

export function createPendingStore(
  getDb: () => Promise<PendingRowsDb>,
  files: PendingFiles,
  onError?: (stage: string, error: unknown) => void,
): DurablePendingStore {
  let tail: Promise<unknown> = Promise.resolve();

  function enqueue(stage: string, write: (db: PendingRowsDb) => Promise<void>): Promise<void> {
    const result = tail.then(async () => write(await getDb()));
    tail = result.catch((error: unknown) => onError?.(stage, error));
    return result;
  }

  return {
    put: (scan) => enqueue('put', (db) => db.putPendingScan(scanToRow(scan, files))),
    remove: (scanId) => enqueue('remove', (db) => db.deletePendingScan(scanId)),
    replace: (previousScanId, scan) =>
      enqueue('replace', (db) => db.replacePendingScan(previousScanId, scanToRow(scan, files))),

    async load() {
      await tail.catch(() => {});
      const rows = await (await getDb()).listPendingScans();
      return rows
        .map((row) => rowToScan(row, files))
        .filter((scan): scan is PendingScan => scan !== null);
    },

    idle: () => tail.then(() => undefined),
  };
}
