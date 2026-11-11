import { assertId, normalizeEmail, normalizeName } from './validation.js';

function copyUser(user) {
  return { id: user.id, name: user.name, email: user.email };
}

export function createUserService() {
  let nextId = 1;
  const users = new Map();
  const emailToId = new Map();

  return {
    create(input) {
      if (input === null || typeof input !== 'object' || Array.isArray(input)) {
        throw new TypeError('user input must be an object');
      }
      const name = normalizeName(input.name);
      const email = normalizeEmail(input.email);
      if (emailToId.has(email)) {
        throw new Error('email is already in use');
      }
      const user = { id: nextId, name, email };
      nextId += 1;
      users.set(user.id, user);
      emailToId.set(email, user.id);
      return copyUser(user);
    },

    get(id) {
      assertId(id);
      const user = users.get(id);
      return user ? copyUser(user) : null;
    },

    findByEmail(email) {
      const normalized = normalizeEmail(email);
      const id = emailToId.get(normalized);
      return id === undefined ? null : copyUser(users.get(id));
    },

    update(id, changes) {
      assertId(id);
      const user = users.get(id);
      if (!user) {
        throw new Error('unknown user');
      }
      if (changes === null || typeof changes !== 'object' || Array.isArray(changes)) {
        throw new TypeError('changes must be an object');
      }
      for (const key of Object.keys(changes)) {
        if (key !== 'name' && key !== 'email') {
          throw new TypeError(`unsupported user field: ${key}`);
        }
      }

      const name = 'name' in changes ? normalizeName(changes.name) : user.name;
      const email = 'email' in changes ? normalizeEmail(changes.email) : user.email;
      const owner = emailToId.get(email);
      if (owner !== undefined && owner !== id) {
        throw new Error('email is already in use');
      }

      if (email !== user.email) {
        emailToId.delete(user.email);
        emailToId.set(email, id);
      }
      user.name = name;
      user.email = email;
      return copyUser(user);
    },

    remove(id) {
      assertId(id);
      const user = users.get(id);
      if (!user) return false;
      users.delete(id);
      emailToId.delete(user.email);
      return true;
    },

    list() {
      return [...users.values()].sort((left, right) => left.id - right.id).map(copyUser);
    },
  };
}
