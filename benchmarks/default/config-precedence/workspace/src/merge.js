export function deepMerge(...sources) {
  return { ...sources.at(-1) };
}
