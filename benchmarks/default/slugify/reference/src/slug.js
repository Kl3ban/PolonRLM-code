export function slugify(value) {
  if (typeof value !== 'string') throw new TypeError('value must be a string');
  return value.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}
