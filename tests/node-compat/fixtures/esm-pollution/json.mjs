// Every string literal the transform EMITS — require specifiers, export keys,
// __filename/__dirname/import.meta.url — is produced by jsonString.
import { helper } from './dep-json.mjs';

export const ok = 'JSON-OK:' + helper();
