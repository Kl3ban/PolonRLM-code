const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

export function normalizeName(name) {
  if (typeof name !== 'string') {
    throw new TypeError('name must be a string');
  }
  const normalized = name.trim();
  if (normalized.length < 1 || normalized.length > 40) {
    throw new RangeError('name must contain between 1 and 40 characters after trimming');
  }
  return normalized;
}

export function normalizeEmail(email) {
  if (typeof email !== 'string') {
    throw new TypeError('email must be a string');
  }
  const normalized = email.trim().toLowerCase();
  if (!EMAIL_PATTERN.test(normalized)) {
    throw new TypeError('email is invalid');
  }
  return normalized;
}

export function assertId(id) {
  if (!Number.isSafeInteger(id) || id < 1) {
    throw new TypeError('id must be a positive safe integer');
  }
  return id;
}
