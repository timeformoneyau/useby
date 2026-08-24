import { UseByItem, ItemStatus, ItemSource, DateType } from '../../types';

export interface CreateItemInput {
  name: string;
  expiryDate: string;
  dateType?: DateType;
  source?: ItemSource;
}

/** A UseByItem with all computed fields attached. Single source of truth for derived state. */
export interface DerivedItem extends UseByItem {
  status: ItemStatus;
}
