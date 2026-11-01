/**
 * "The saved items changed" — a signal, not a store.
 *
 * `service.ts` raises it after every successful write (create, edit, Used /
 * Delete). Anything that has to follow the item list — today, expiry
 * reminders — listens here instead of being called from the service, so item
 * persistence knows nothing about notifications and stays loadable by the
 * offline suite. Listeners re-read the items themselves; nothing is passed.
 *
 * No value imports.
 */
type Listener = () => void;

const listeners = new Set<Listener>();

export function onItemsChanged(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function emitItemsChanged(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // A listener's failure is its own; the write already succeeded.
    }
  }
}
