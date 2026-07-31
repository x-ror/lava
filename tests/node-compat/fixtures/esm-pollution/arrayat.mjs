// Same invariant as charat.mjs, reached through the mask's mode STACK rather than
// its character reads: a template literal whose body is statement-shaped text.
import { helper } from './dep-arrayat.mjs';

export const tpl = `;import evil from './does-not-exist.mjs';`;
export const ok = 'ARRAYAT-OK:' + helper();
