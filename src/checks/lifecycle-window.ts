import { lifecycleCheck } from '../lifecycle';
import type { Store } from '../store';
import { check } from './_check';

export default check('lifecycle:window');

export function lifecycleWindowCheck(store: Store, now?: number) {
  return { name: 'lifecycle:window', ...lifecycleCheck(store, 'window', now) };
}
