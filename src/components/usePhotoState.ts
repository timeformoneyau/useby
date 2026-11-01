import { useEffect, useMemo } from 'react';
import { photoStore } from '../domain/items/photoStore';
import type { PhotoState } from '../domain/items/photos';
import { photoTrace } from '../domain/scan/diagnostics';

/**
 * A saved item's photo, resolved for display, with any problem logged.
 *
 * `missing` (the record names a file that is not on disk) and `invalid` (it
 * names something we never wrote) each write one `useby.photo` line, so a
 * device run separates "this item never had a photo" from "this item's photo
 * went missing". `none` is not logged: manual adds and items saved before
 * durable retention simply have no photo.
 */
export function usePhotoState(
  filename: string | undefined,
  where: 'home' | 'detail',
): PhotoState {
  const state = useMemo(() => photoStore.stateFor(filename), [filename]);

  useEffect(() => {
    if (state.kind === 'missing') photoTrace('missing', where, state.filename);
    else if (state.kind === 'invalid') photoTrace('invalid', where, filename);
  }, [state, where, filename]);

  return state;
}
