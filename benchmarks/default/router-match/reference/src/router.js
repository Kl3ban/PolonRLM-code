import { assertMethod, compilePattern, matchPath } from './pattern.js';

export function createRouter(routes) {
  if (!Array.isArray(routes)) {
    throw new TypeError('routes must be an array');
  }

  const prepared = routes.map((route, index) => {
    if (route === null || typeof route !== 'object' || Array.isArray(route)) {
      throw new TypeError(`routes[${index}] must be an object`);
    }
    if (typeof route.path !== 'string') {
      throw new TypeError(`routes[${index}].path must be a string`);
    }
    return {
      method: assertMethod(route.method),
      path: route.path,
      handler: route.handler,
    };
  });

  for (const route of prepared) {
    compilePattern(route.path);
  }

  return {
    match(method, pathname) {
      const requestedMethod = assertMethod(method);
      for (const route of prepared) {
        if (route.method !== requestedMethod) continue;
        const params = matchPath(route.path, pathname);
        if (params !== null) {
          return {
            handler: route.handler,
            params,
            method: route.method,
            path: route.path,
          };
        }
      }
      return null;
    },
  };
}
