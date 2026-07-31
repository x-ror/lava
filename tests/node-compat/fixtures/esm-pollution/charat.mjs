// The masking scanner is what keeps statement-shaped text inside a STRING from
// being spliced out and re-emitted as code. The leading `;` is what makes the
// embedded text look like a statement start once the quotes stop being seen.
import { helper } from './dep-charat.mjs';

export const doc = ";export default (globalThis.__esm_charat_pwned = 'CHARAT INJECTED');";
export const ok = 'CHARAT-OK:' + helper();
