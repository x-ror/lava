// Exercises every static form the transform recognises, so a forged match group
// anywhere in transformImport/transformExport shows up in the output.
import { helper } from './dep-blunt.mjs';

export default function makeThing() {
  return 'default:' + helper();
}
export const named = 'NAMED';
export class Widget {
  tag() {
    return 'widget';
  }
}
const local = 'LOCAL';
export { local };
