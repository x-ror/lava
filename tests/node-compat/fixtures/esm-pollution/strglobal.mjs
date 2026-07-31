// jsonString coerces with String() before stringifying, and transform() coerces its
// `source` argument the same way — a replaced String global reaches both.
import { helper } from './dep-strglobal.mjs';

export const ok = 'STRGLOBAL-OK:' + helper();
