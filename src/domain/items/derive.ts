import { UseByItem } from '../../types';
import { DerivedItem } from './types';
import { computeItemStatus } from '../../utils/statusUtils';

/**
 * Canonical derivation of all computed fields for a UseByItem.
 * All parts of the app that need status/secondary-line/sort data should
 * go through this function to guarantee consistency.
 */
export function deriveItem(item: UseByItem): DerivedItem {
  return {
    ...item,
    status: computeItemStatus(item),
  };
}
