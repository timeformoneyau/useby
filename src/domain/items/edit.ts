/**
 * Editing a saved item: what changes, and what must survive untouched.
 *
 * Pure, and separated from `service.ts` for the usual reason — that module
 * imports AsyncStorage and the photo store, so it cannot be loaded offline,
 * and the rules below are exactly the part worth testing. Everything here is a
 * statement about a record, not about storage.
 *
 * Two fields are editable and no others. The rest of the record is *identity*
 * and *provenance*, and an edit is not permitted to disturb either:
 *
 * - `id` and `createdAt` are what make this the same item rather than a new
 *   one. Editing by deleting and recreating would break every reference to it,
 *   the retained photo among them.
 * - `photo` names a file on disk. Metadata editing does not touch the
 *   filesystem at all, so the name is carried across verbatim; changing or
 *   clearing it here would orphan a file at best and break the image at worst.
 * - `source` records how the item came into existence. That does not stop
 *   being true because someone fixed a typo.
 * - `dateType` records **what the packaging said**, which is history. See the
 *   note on `dateUserSet` below — this is the one that needed thought.
 */
import type { UseByItem } from '../../types';

/**
 * What a person may change about a saved item.
 *
 * Deliberately two fields. Date *type* is absent because it is no longer a
 * consumer concept: the product presents one idea, "Use By", and asking someone
 * to classify their own groceries against a distinction the interface does not
 * otherwise make would be asking them to do the system's filing.
 *
 * Both optional, so "rename only" and "re-date only" are ordinary cases rather
 * than a caller having to resend a value it does not mean to change.
 */
export interface ItemEdit {
  name?: string;
  expiryDate?: string;
}

/**
 * True when an edit would actually alter the stored record.
 *
 * A Save that changes nothing should not bump `updatedAt` or set
 * `dateUserSet` — "the user opened the editor and pressed Save" is not the same
 * event as "the user changed the date", and only the second one should leave a
 * mark on provenance.
 */
export function editChangesAnything(item: UseByItem, edit: ItemEdit): boolean {
  const renamed = edit.name !== undefined && edit.name.trim() !== item.name;
  const redated = edit.expiryDate !== undefined && edit.expiryDate !== item.expiryDate;
  return renamed || redated;
}

/**
 * Apply an edit to a saved item.
 *
 * Returns a new record; never mutates the input. `now` is passed in rather than
 * read from the clock so `updatedAt` is testable.
 *
 * ## Why `dateUserSet` exists
 *
 * `dateType` says what the *packaging* said — `use_by`, `best_before`, or
 * `unknown` when the pack printed a bare date. It is kept for evidence,
 * diagnostics and any future food-safety behaviour, and it is no longer shown
 * to anyone: the interface presents a single "Use By" date.
 *
 * The moment a person changes the date, that provenance stops describing the
 * value in the record. The pack said "BEST BEFORE 04/09/26"; the item now says
 * 12 September, because the reader got it wrong and a human fixed it. Leaving
 * `dateType: best_before` sitting beside that date quietly asserts the
 * packaging printed something it did not.
 *
 * The two obvious repairs are both wrong. Clearing `dateType` destroys the
 * observation. Rewriting it to `use_by` invents one.
 *
 * So neither: the observation stays exactly as recorded, and one boolean says
 * the stored date is a person's rather than the pack's. Anything later that
 * wants to act on date *semantics* — "this is past its use-by, do not eat it" —
 * can then see that the provenance applies to a date that is no longer here,
 * and decline to make a safety claim it cannot support. That is the whole of
 * the mechanism; it is deliberately not a history or an audit trail.
 */
export function applyItemEdit(
  item: UseByItem,
  edit: ItemEdit,
  now: string,
): UseByItem {
  const name = edit.name !== undefined ? edit.name.trim() : item.name;

  // An empty name is refused rather than saved. The editor disables Save
  // without one, so this is the second line — and an unnamed item cannot be
  // found again by the person who owns it.
  const nextName = name.length > 0 ? name : item.name;

  const nextDate = edit.expiryDate ?? item.expiryDate;
  const dateMoved = nextDate !== item.expiryDate;

  return {
    ...item,
    name: nextName,
    expiryDate: nextDate,
    // Sticky once set: an item whose date a person has already corrected does
    // not become the packaging's again because they later fixed the spelling
    // of its name.
    ...(dateMoved || item.dateUserSet ? { dateUserSet: true } : {}),
    updatedAt: now,
  };
}
