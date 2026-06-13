import { getA } from './a.mjs';
export const b = 2;
export function getB() {
  return b;
}
export function viaA() {
  return getA();
}
