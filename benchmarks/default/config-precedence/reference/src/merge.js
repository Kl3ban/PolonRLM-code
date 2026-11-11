function isPlain(value) {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (isPlain(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)]));
  return value;
}
function merge(target, source) {
  const output = isPlain(target) ? clone(target) : {};
  if (!isPlain(source)) return output;
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    output[key] = isPlain(value) && isPlain(output[key]) ? merge(output[key], value) : clone(value);
  }
  return output;
}
export function deepMerge(...sources) {
  return sources.reduce((result, source) => merge(result, source), {});
}
