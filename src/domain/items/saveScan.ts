/**
 * The handover: a reviewed scan becoming a saved item.
 *
 * Three things have to happen and the order is the whole point, because each
 * step can fail independently and only one ordering fails safely:
 *
 *   1. **Retain** — copy the scan image out of the cache directory it has been
 *      living in and into durable storage.
 *   2. **Create** — write the item, naming that file.
 *   3. **Release** — let the queue retire the draft, which deletes the
 *      temporary copy.
 *
 * Read against the failures rather than the happy path:
 *
 * - *Retain fails.* The item saves with no photo. A missing photo is a minor
 *   degradation; refusing to save someone's groceries over a file copy would
 *   be absurd.
 * - *Create fails.* Nothing is released, so the draft survives and the user can
 *   try again with the form still filled in. A durable file may have been
 *   written that nothing refers to — the start-up sweep collects it, and it is
 *   invisible in the meantime.
 * - *Release fails.* Cannot, in practice: the queue's own release is best
 *   effort and swallows filesystem errors. The worst case is a temporary file
 *   left in a directory the OS reclaims anyway.
 *
 * What no ordering here can produce is the one failure that would be visible
 * weeks later: an item naming a file that was never written.
 *
 * Extracted from the editor rather than left inline so this sequencing is
 * testable. It has no value imports — the dependencies are injected, the same
 * pattern `pending.ts` and `photos.ts` use — so Node's type stripping loads it
 * and the offline suite can provoke each failure above, none of which can be
 * reproduced against a real filesystem.
 */
import type { CreateItemInput } from './types';

export interface SaveScanDeps {
  /** Copy into durable storage. Returns the stored filename, or null. */
  retain: (scanId: string, sourceUri: string) => string | null;
  /** Persist the item. May reject; the caller decides what that means. */
  create: (input: CreateItemInput) => Promise<unknown>;
  /** Retire the pending draft, releasing its temporary image. */
  release: (scanId: string) => void;
}

export interface SaveScanRequest extends CreateItemInput {
  /** The pending draft this came from. Absent for a manual add. */
  scanId?: string;
  /** Where its temporary image is. Absent if the draft never had one. */
  photoUri?: string;
}

/**
 * Run the handover. Rejects only if `create` rejects, which is the one failure
 * the user has to know about because their item is not saved.
 */
export async function saveScannedItem(
  deps: SaveScanDeps,
  request: SaveScanRequest,
): Promise<void> {
  const { scanId, photoUri, ...input } = request;

  // Both halves are needed: a manual add has neither, and a draft whose image
  // was already lost has the id but nothing to copy.
  const photo =
    scanId && photoUri ? (deps.retain(scanId, photoUri) ?? undefined) : undefined;

  await deps.create({ ...input, ...(photo ? { photo } : {}) });

  // Only now. Reversed, a failed write would take the scan with it and leave
  // the user with neither an item nor the draft they were editing.
  if (scanId) deps.release(scanId);
}
