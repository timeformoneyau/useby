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
import { File } from 'expo-file-system';
import { scanPhoto } from './client';
import { emptyPrefill } from './mapping';
import { createScanQueue, type ScanRunner } from './pending';

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
function releaseImage(imageUri: string): void {
  try {
    const file = new File(imageUri);
    if (file.exists) file.delete();
  } catch {
    // Nothing to do and nothing worth saying: see above.
  }
}

export const scanQueue = createScanQueue({ run, onRelease: releaseImage });
