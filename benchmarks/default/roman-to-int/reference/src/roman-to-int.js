const VALUES = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
const CANONICAL = /^M{0,3}(CM|CD|D?C{0,3})(XC|XL|L?X{0,3})(IX|IV|V?I{0,3})$/;

export function romanToInt(roman) {
  if (typeof roman !== 'string') throw new TypeError('roman must be a string');
  if (roman === '' || !CANONICAL.test(roman)) throw new TypeError(`invalid Roman numeral: "${roman}"`);
  let total = 0;
  for (let index = 0; index < roman.length; index += 1) {
    const current = VALUES[roman[index]];
    const next = VALUES[roman[index + 1]];
    total += next !== undefined && current < next ? -current : current;
  }
  return total;
}
