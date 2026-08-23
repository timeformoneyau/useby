import { UseByItem, ItemStatus, ItemSource } from '../../types';

export interface CreateItemInput {
  name: string;
  expiryDate: string;
  source?: ItemSource;
}

/** A UseByItem with all computed fields attached. Single source of truth for derived state. */
export interface DerivedItem extends UseByItem {
  status: ItemStatus;
}
