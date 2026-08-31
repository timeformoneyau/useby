import { UseByItem, ItemStatus, ItemSource, DateType } from '../../types';

export interface CreateItemInput {
  name: string;
  expiryDate: string;
  dateType?: DateType;
  source?: ItemSource;
  /** Filename of an already-retained photo. See `UseByItem.photo`. */
  photo?: string;
  /** The date being saved is the user's, not the pack's. See `UseByItem.dateUserSet`. */
  dateUserSet?: boolean;
}

/** A UseByItem with all computed fields attached. Single source of truth for derived state. */
export interface DerivedItem extends UseByItem {
  status: ItemStatus;
}
