export function validateSchema(schema, value) {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
    throw new TypeError('schema must be an object');
  }
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
