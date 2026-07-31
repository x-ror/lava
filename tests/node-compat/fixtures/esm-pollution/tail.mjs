// `export const` is one of the seven transformExport paths that return no own `tail`,
// so it is where an inherited one would be picked up and emitted.
import { helper } from './dep-tail.mjs';

export const ok = 'TAIL-OK:' + helper();
