// The unpoisoned control: a "fix" that simply refuses to transform anything must
// not be able to pass this file.
import { helper } from './dep-clean.mjs';

export default function makeThing() {
  return 'default:' + helper();
}
export const named = 'NAMED';
const local = 'LOCAL';
export { local };
