export function deepMerge(base, override) {
  return { ...base, ...override };
}
