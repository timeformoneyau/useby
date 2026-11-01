/**
 * Single Item / Multiple Items: what the camera does after a photo, and how
 * you leave it.
 *
 * Most of the time someone opens the camera to add one thing. Before modes
 * existed the camera always behaved as if a whole bag were being unpacked: it
 * stayed open after every photo, so adding one item meant photographing it and
 * then finding "Done". Now:
 *
 * - **Single Item** (the default for every fresh visit): one photo, then
 *   straight back to Home. Recognition carries on in the background and the
 *   draft appears on Home, first as "Checking…", then as its result or a clear
 *   failure. Nothing waits for the model, and nothing is saved unreviewed.
 * - **Multiple Items**: the camera stays open after each photo, the running
 *   count shows what is being checked and what is ready, and Finish returns to
 *   Home with every draft intact.
 *
 * Modes are a state of the camera, not separate screens: the four-screen
 * architecture stands. The mode lives for one visit to the camera and is not
 * remembered between visits, so a fresh visit always starts in Single Item.
 *
 * Pure and dependency-free so the offline suite can pin the rules directly.
 */

export type CaptureMode = 'single' | 'multiple';

/** Every fresh visit to the camera starts here. */
export const DEFAULT_CAPTURE_MODE: CaptureMode = 'single';

export const CAPTURE_MODES: readonly { mode: CaptureMode; label: string }[] = [
  { mode: 'single', label: 'Single item' },
  { mode: 'multiple', label: 'Multiple items' },
];

/**
 * What happens once a photo has been handed to the queue.
 *
 * Only after a *successful* hand-over: a photo that could not be taken or
 * resized leaves the person on the camera with the error, in either mode, so
 * they can simply try again.
 */
export function afterCapture(mode: CaptureMode): 'return-home' | 'stay' {
  return mode === 'single' ? 'return-home' : 'stay';
}

export interface CameraExits {
  /**
   * The quiet way out, top-left: leave without capturing anything. Present
   * whenever this visit has not produced a draft in Multiple Items mode, and
   * always in Single Item mode (where a capture leaves the camera by itself).
   */
  cancel: boolean;
  /**
   * The obvious way out of a Multiple Items session that has photos in it.
   * Returns Home; nothing pending is dropped.
   */
  finish: boolean;
}

/**
 * Which exits the camera shows.
 *
 * `capturedThisVisit` counts photos successfully handed over during this visit
 * to the camera, not the whole queue: drafts left over from earlier are still
 * on Home, and leaving now does nothing to them, so they are not a reason to
 * call the exit "Finish".
 */
export function cameraExits(mode: CaptureMode, capturedThisVisit: number): CameraExits {
  if (mode === 'single') return { cancel: true, finish: false };
  const finish = capturedThisVisit > 0;
  return { cancel: !finish, finish };
}

/** "Finish (3)" — the count is this visit's photos, so it matches what was just done. */
export function finishLabel(capturedThisVisit: number): string {
  return capturedThisVisit > 0 ? `Finish (${capturedThisVisit})` : 'Finish';
}
