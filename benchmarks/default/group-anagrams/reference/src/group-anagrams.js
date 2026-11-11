export function groupAnagrams(words) {
  if (!Array.isArray(words)) throw new TypeError('words must be an array');
  for (const word of words) {
    if (typeof word !== 'string' || !/^[a-z]+$/.test(word)) throw new TypeError('words must be non-empty lowercase a-z strings');
  }
  const groups = new Map();
  for (const word of words) {
    const key = word.split('').sort().join('');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(word);
  }
  return [...groups.values()];
}
