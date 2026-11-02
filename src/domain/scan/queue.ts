/**
 * The app's one scan queue, wired to the real network call.
 *
 * Split from `pending.ts` on purpose. That file is the machine and imports
 * nothing at runtime, so Node's type stripping loads it and the offline suite
 * exercises the queue with a fake runner. This file is the plug: it is the only
 * place the queue meets `fetch`, and nothing in the test suite imports it.
 *
 * Module scope rather than a React context or provider. The requirement that
 * drove this whole change is that a scan must outlive the screen that started
 * it — so its owner cannot be a component, however high in the tree. A module
 * binding is created once, is never unmounted, and cannot be torn down by a
 * navigation the user makes while a photo is still being read.
 */
import { Directory, File, Paths } from 'expo-file-system';
import { scanPhoto } from './client';
import { newScanId } from './diagnostics';
import { emptyPrefill } from './mapping';
import { createScanQueue, type ScanRunner } from './pending';
import {
  PENDING_FILE,
  createPendingStore,
  orphanPendingFiles,
  pendingFilename,
  type PendingFiles,
} from './pendingStore';
import { itemDatabase } from '../items/storage';

/**
 * Turn a scan into editor state.
 *
 * The queue deals only in "there is a draft to review"; deciding *what* that
 * draft says is mapping's job, and it already knows. Both branches produce a
 * prefill, which is what makes a failed scan reviewable rather than lost: the
 * editor opens with the notice on it and the user types the item in, exactly as
 * it behaved when the wait was synchronous.
 */
const run: ScanRunner = async (job) => {
  const result = await scanPhoto(job.imageBase64, job.scanId, {
    ...job.capture,
    queuedMs: job.queuedMs,
  });

  return result.ok
    ? { ok: true, prefill: result.prefill, trust: result.trust }
    : { ok: false, prefill: emptyPrefill('photo', result.message) };
};

/**
 * Delete the resized photo a draft was holding, once nothing refers to it.
 *
 * These live in the cache directory, where `manipulateAsync` writes them, and
 * are a few hundred kilobytes each. The OS will reclaim that directory under
 * storage pressure, so leaving them is survivable rather than a true leak — but
 * an unpacking session is a run of them and tidying up after ourselves is
 * cheap. The queue calls this exactly once per retained image.
 *
 * Fails soft, deliberately and in both directions. The file may already be gone
 * (the OS cleared the cache, or the same URI settled twice through a path we
 * have not thought of), and a draft the user just saved must not surface an
 * error because a temporary file could not be deleted. There is nothing here
 * the user could act on.
 */
/**
 * Draft photos live here from the shutter until Save, Discard or Retake.
 *
 * Not the cache directory, where `manipulateAsync` writes them: Android
 * reclaims that under storage pressure, and a draft that is meant to survive the
 * app being killed must not lose its photograph to the same event. Separate from
 * the saved-item `photos/` directory so neither sweep can touch the other's
 * files. Saving copies the image into `photos/` exactly as before.
 */
const PENDING_DIR = 'pending';

function pendingDir(): Directory {
  return new Directory(Paths.document, PENDING_DIR);
}

function pendingFile(filename: string): File {
  return new File(Paths.document, PENDING_DIR, filename);
}

/** Move a fresh capture into the pending directory. Falls back to where it was. */
function adoptImage(scanId: string, imageUri: string): string {
  const filename = pendingFilename(scanId);
  if (!filename) return imageUri;
  try {
    pendingDir().create({ idempotent: true, intermediates: true });
    const target = pendingFile(filename);
    if (target.exists) target.delete();
    const source = new File(imageUri);
    source.move(target);
    return target.exists ? target.uri : imageUri;
  } catch {
    return imageUri;
  }
}

function readImage(imageUri: string): string | null {
  try {
    const file = new File(imageUri);
    return file.exists ? file.base64Sync() : null;
  } catch {
    return null;
  }
}

const files: PendingFiles = {
  fileOf(imageUri) {
    const filename = imageUri.split('/').pop() ?? '';
    if (!PENDING_FILE.test(filename)) return null;
    return pendingFile(filename).uri === imageUri ? filename : null;
  },
  uriOf(filename) {
    if (!PENDING_FILE.test(filename)) return null;
    try {
      const file = pendingFile(filename);
      return file.exists ? file.uri : null;
    } catch {
      return null;
    }
  },
};

/** One line per failure to persist. Never the item name. */
function logStoreError(stage: string, error: unknown): void {
  console.log(
    `useby.pending ${JSON.stringify({ stage, outcome: 'persist-failed', error: String(error).slice(0, 200) })}`,
  );
}

const pendingStore = createPendingStore(itemDatabase, files, logStoreError);

function releaseImage(imageUri: string): void {
  try {
    const file = new File(imageUri);
    if (file.exists) file.delete();
  } catch {
    // Nothing to do and nothing worth saying: see above.
  }
}

export const scanQueue = createScanQueue({
  run,
  onRelease: releaseImage,
  store: pendingStore,
  adoptImage,
  readImage,
  newScanId,
});

/**
 * Start-up: bring back the drafts an earlier process left, then delete any
 * pending photo no draft names (a crash between a save and its clean-up, a
 * draft that expired). Once per launch, from `App.tsx`.
 *
 * The sweep runs after the restore, against what the queue now holds, so it
 * can only delete a file nothing refers to. It is synchronous from the moment
 * the drafts are known, so no capture can interleave with it.
 */
export async function restorePendingScans(): Promise<void> {
  const saved = await pendingStore.load();
  const report = scanQueue.restore(saved);

  let swept = 0;
  try {
    const listed = pendingDir()
      .list()
      .map((entry) => entry.name);
    for (const name of orphanPendingFiles(listed, scanQueue.snapshot(), files)) {
      try {
        pendingFile(name).delete();
        swept += 1;
      } catch {
        // Next launch.
      }
    }
  } catch {
    // No pending directory yet: nothing was ever photographed.
  }

  console.log(`useby.pending ${JSON.stringify({ stage: 'restore', ...report, swept })}`);
}
