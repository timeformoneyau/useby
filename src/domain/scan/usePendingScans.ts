/**
 * React's view of the scan queue.
 *
 * `useSyncExternalStore` rather than state mirrored in an effect: it is the
 * built-in answer to exactly this shape (a store that lives outside React and
 * changes on its own schedule), it subscribes and unsubscribes correctly across
 * the screen transitions this feature is full of, and it cannot tear — Home and
 * the camera read one snapshot and always agree about it. No dependency, no
 * provider, no context boundary to get wrong.
 *
 * The store returns the same array reference until something actually changes,
 * which is the contract this hook depends on; see `publish` in `pending.ts`.
 */
import { useSyncExternalStore } from 'react';
import { scanQueue } from './queue';
import { countsLine, type PendingScan, type ScanCounts } from './pending';

export function usePendingScans(): readonly PendingScan[] {
  return useSyncExternalStore(scanQueue.subscribe, scanQueue.snapshot);
}

/**
 * Counts, for the camera's status line.
 *
 * Derived from the same snapshot rather than by calling `counts()` in render:
 * `counts()` builds a fresh object each time, and returning one of those from
 * `getSnapshot` is the reference-identity mistake that loops forever.
 */
export function usePendingCounts(): { counts: ScanCounts; line: string | null } {
  const scans = usePendingScans();

  let checking = 0;
  let toReview = 0;
  for (const scan of scans) {
    if (scan.status === 'queued' || scan.status === 'active') checking += 1;
    else toReview += 1;
  }

  const counts = { checking, toReview };
  return { counts, line: countsLine(counts) };
}
