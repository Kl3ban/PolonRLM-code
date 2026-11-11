const TYPES = new Set(['string', 'number', 'boolean']);
const ALLOWED_KEYS = new Set(['type', 'required', 'minLength', 'maxLength', 'min', 'max', 'enum']);

function validateDescriptor(field, descriptor) {
  if (descriptor === null || typeof descriptor !== 'object' || Array.isArray(descriptor)) {
    throw new TypeError(`descriptor for field ${field} must be an object`);
  }
  for (const key of Object.keys(descriptor)) {
    if (!ALLOWED_KEYS.has(key)) throw new TypeError(`descriptor for field ${field} has unknown key ${key}`);
  }
  const type = descriptor.type;
  if (!TYPES.has(type)) throw new TypeError(`descriptor for field ${field} has an invalid type`);
  const has = key => Object.hasOwn(descriptor, key);

  if (has('required') && typeof descriptor.required !== 'boolean') {
    throw new TypeError(`descriptor for field ${field} has a non-boolean required`);
  }
  if (has('minLength')) {
    if (type !== 'string') throw new TypeError(`field ${field} applies minLength to a non-string`);
    if (!Number.isSafeInteger(descriptor.minLength) || descriptor.minLength < 0) {
      throw new TypeError(`field ${field} has an invalid minLength`);
    }
  }
  if (has('maxLength')) {
    if (type !== 'string') throw new TypeError(`field ${field} applies maxLength to a non-string`);
    if (!Number.isSafeInteger(descriptor.maxLength) || descriptor.maxLength < 0) {
      throw new TypeError(`field ${field} has an invalid maxLength`);
    }
  }
  if (has('minLength') && has('maxLength') && descriptor.minLength > descriptor.maxLength) {
    throw new TypeError(`field ${field} has minLength greater than maxLength`);
  }
  if (has('min')) {
    if (type !== 'number') throw new TypeError(`field ${field} applies min to a non-number`);
    if (typeof descriptor.min !== 'number' || !Number.isFinite(descriptor.min)) {
      throw new TypeError(`field ${field} has an invalid min`);
    }
  }
  if (has('max')) {
    if (type !== 'number') throw new TypeError(`field ${field} applies max to a non-number`);
    if (typeof descriptor.max !== 'number' || !Number.isFinite(descriptor.max)) {
      throw new TypeError(`field ${field} has an invalid max`);
    }
  }
  if (has('min') && has('max') && descriptor.min > descriptor.max) {
    throw new TypeError(`field ${field} has min greater than max`);
  }
  if (has('enum')) {
    if (!Array.isArray(descriptor.enum) || descriptor.enum.length === 0) {
      throw new TypeError(`field ${field} has an invalid enum`);
    }
    for (const entry of descriptor.enum) {
      const valid = type === 'string'
        ? typeof entry === 'string'
        : type === 'number'
          ? typeof entry === 'number' && Number.isFinite(entry)
          : typeof entry === 'boolean';
      if (!valid) throw new TypeError(`field ${field} has an enum entry of the wrong type`);
    }
  }
}

export function validateSchema(schema, value) {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
    throw new TypeError('schema must be an object');
  }
  const fields = Object.entries(schema);
  for (const [field, descriptor] of fields) validateDescriptor(field, descriptor);

  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;

  for (const [field, descriptor] of fields) {
    const present = Object.hasOwn(value, field) && value[field] !== undefined;
    if (!present) {
      if (descriptor.required !== false) return false;
      continue;
    }
    const fieldValue = value[field];
    if (descriptor.type === 'string') {
      if (typeof fieldValue !== 'string') return false;
      if (Object.hasOwn(descriptor, 'minLength') && fieldValue.length < descriptor.minLength) return false;
      if (Object.hasOwn(descriptor, 'maxLength') && fieldValue.length > descriptor.maxLength) return false;
    } else if (descriptor.type === 'number') {
      if (typeof fieldValue !== 'number' || !Number.isFinite(fieldValue)) return false;
      if (Object.hasOwn(descriptor, 'min') && fieldValue < descriptor.min) return false;
      if (Object.hasOwn(descriptor, 'max') && fieldValue > descriptor.max) return false;
    } else if (typeof fieldValue !== 'boolean') {
      return false;
    }
    if (Object.hasOwn(descriptor, 'enum') && !descriptor.enum.some(entry => Object.is(entry, fieldValue))) return false;
  }
  return true;
}
