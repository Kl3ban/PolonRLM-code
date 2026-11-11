const PARAMETER_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function splitPath(path, label) {
  if (typeof path !== 'string' || !path.startsWith('/')) {
    throw new TypeError(`${label} must be a string starting with '/'`);
  }
  if (path.includes('//')) {
    throw new TypeError(`${label} must not contain empty segments`);
  }
  const normalized = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
  if (normalized === '/') return [];
  return normalized.slice(1).split('/');
}

function assertMethod(method) {
  if (typeof method !== 'string' || method.trim().length === 0) {
    throw new TypeError('method must be a non-empty string');
  }
  return method.trim().toUpperCase();
}

export function compilePattern(pattern) {
  const segments = splitPath(pattern, 'pattern');
  const seen = new Set();
  return segments.map(segment => {
    if (segment.startsWith(':')) {
      const name = segment.slice(1);
      if (!PARAMETER_NAME.test(name)) {
        throw new TypeError(`invalid parameter name: ${name}`);
      }
      if (seen.has(name)) {
        throw new TypeError(`duplicate parameter name: ${name}`);
      }
      seen.add(name);
      return { name };
    }
    if (segment.includes(':') || segment.includes('*')) {
      throw new TypeError('static segments must not contain ":" or "*"');
    }
    return segment;
  });
}

export function matchPath(pattern, pathname) {
  const compiled = compilePattern(pattern);
  if (typeof pathname !== 'string' || !pathname.startsWith('/')) {
    throw new TypeError("pathname must be a string starting with '/'");
  }
  const parts = splitPath(pathname, 'pathname');
  if (parts.length !== compiled.length) return null;

  const params = {};
  for (let index = 0; index < compiled.length; index += 1) {
    const segment = compiled[index];
    const value = parts[index];
    if (typeof segment === 'string') {
      if (segment !== value) return null;
    } else {
      params[segment.name] = value;
    }
  }
  return params;
}

export { assertMethod };
