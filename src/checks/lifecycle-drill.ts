import { lifecycleCheck } from '../lifecycle';
import type { Store } from '../store';
import { check } from './_check';

export default check('lifecycle:drill');

export function lifecycleDrillCheck(store: Store, now?: number) {
  return { name: 'lifecycle:drill', ...lifecycleCheck(store, 'drill', now) };
}
