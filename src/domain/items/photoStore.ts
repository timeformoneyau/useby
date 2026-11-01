/**
 * The app's one photo store, wired to the real filesystem.
 *
 * Split from `photos.ts` for the same reason `queue.ts` is split from
 * `pending.ts`: that file is the policy and imports nothing at runtime, so the
 * offline suite loads it under Node's type stripping and drives the whole
 * lifecycle against a fake filesystem. This file is the plug, and it is the
 * only place in the app that names a directory or touches `expo-file-system`
 * for durable photos.
 */
import { Directory, File, Paths } from 'expo-file-system';
import { createPhotoStore, type PhotoFs } from './photos';

/**
 * `Paths.document`, not `Paths.cache`.
 *
 * The cache directory is where the scan image starts life and it is exactly
 * what Android reclaims under storage pressure — fine for a draft that lives
 * for a minute, wrong for a record the user expects to still be there next
 * month. The document directory is app-private, survives restarts and updates,
 * is never reclaimed, and needs no runtime permission on either platform.
 */
const PHOTOS_DIR = 'photos';

function dir(): Directory {
  return new Directory(Paths.document, PHOTOS_DIR);
}

function file(filename: string): File {
  return new File(Paths.document, PHOTOS_DIR, filename);
}

/**
 * The adapter. Deliberately thin — every decision lives in `photos.ts`, and
 * everything here is one filesystem call so there is nothing to get wrong that
 * a test could not have caught.
 */
const expoFs: PhotoFs = {
  ensureDir() {
    dir().create({ idempotent: true, intermediates: true });
  },

  copy(sourceUri, filename) {
    new File(sourceUri).copy(file(filename));
  },

  delete(filename) {
    file(filename).delete();
  },

  exists(filename) {
    return file(filename).exists;
  },

  list() {
    // `list()` returns directories as well as files. Only the leaf name is
    // wanted, and a directory in here would not match the photo naming rule
    // anyway, so `name` is enough and the type mix is harmless.
    return dir()
      .list()
      .map((entry) => entry.name);
  },

  uriFor(filename) {
    return file(filename).uri;
  },
};

export const photoStore = createPhotoStore(expoFs);
