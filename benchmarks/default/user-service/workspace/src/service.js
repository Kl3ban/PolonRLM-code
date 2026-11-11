import { assertId, normalizeEmail, normalizeName } from './validation.js';

export function createUserService() {
  let nextId = 1;
  const users = new Map();

  return {
    create(input) {
      const user = { id: nextId, name: input?.name, email: input?.email };
      nextId += 1;
      users.set(user.id, user);
      return { ...user };
    },
    get(id) {
      const user = users.get(id);
      return user ? { ...user } : null;
    },
    findByEmail(email) {
      const user = [...users.values()].find(candidate => candidate.email === email);
      return user ? { ...user } : null;
    },
    update(id, changes) {
      const user = users.get(id);
      if (!user) throw new Error('unknown user');
      Object.assign(user, changes);
      return { ...user };
    },
    remove(id) {
      return users.delete(id);
    },
    list() {
      return [...users.values()].map(user => ({ ...user }));
    },
  };
}
