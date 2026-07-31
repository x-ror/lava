// `export default function` is the sharpest emission site: the transform pulls the
// declared NAME out of a match group and interpolates it into the emitted CJS as an
// identifier, so a forged group is executed source, not a wrong answer.
import { helper } from './dep-targeted.mjs';

export default function makeThing() {
  return 'default:' + helper();
}
export const named = 'NAMED';
