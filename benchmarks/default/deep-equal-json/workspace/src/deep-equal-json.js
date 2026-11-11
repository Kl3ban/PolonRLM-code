export function deepEqualJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}
