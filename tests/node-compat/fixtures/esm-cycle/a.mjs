import { getB } from './b.mjs';
export const a = 1;
export function getA() {
  return a;
}
export function viaB() {
  return getB();
}
