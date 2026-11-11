import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

export async function grade(workspace) {
  try {
    const mod = await import(pathToFileURL(`${workspace}/src/index.js`).href + `?grade=${Date.now()}`);
    const { assertId, createUserService, normalizeEmail, normalizeName } = mod;
    for (const fn of [assertId, createUserService, normalizeEmail, normalizeName]) {
      assert.equal(typeof fn, 'function');
    }

    assert.equal(normalizeName('  Ada Lovelace  '), 'Ada Lovelace');
    assert.equal(normalizeName('x'.repeat(40)), 'x'.repeat(40));
    assert.equal(normalizeEmail(' ADA@Example.COM '), 'ada@example.com');
    assert.equal(assertId(1), 1);
    assert.throws(() => normalizeName('   '), Error);
    assert.throws(() => normalizeName('x'.repeat(41)), Error);
    assert.throws(() => normalizeName(42), Error);
    assert.throws(() => normalizeEmail('ada.example.com'), Error);
    assert.throws(() => normalizeEmail('ada@example'), Error);
    assert.throws(() => normalizeEmail('ada @example.com'), Error);
    assert.throws(() => normalizeEmail(null), Error);
    assert.throws(() => assertId(0), Error);
    assert.throws(() => assertId(1.5), Error);
    assert.throws(() => assertId('1'), Error);

    const users = createUserService();
    const ada = users.create({ name: '  Ada Lovelace  ', email: ' ADA@Example.COM ' });
    assert.deepEqual(ada, { id: 1, name: 'Ada Lovelace', email: 'ada@example.com' });
    const grace = users.create({ name: 'Grace Hopper', email: 'grace@example.com' });
    assert.deepEqual(grace, { id: 2, name: 'Grace Hopper', email: 'grace@example.com' });
    assert.deepEqual(users.list(), [ada, grace]);
    assert.deepEqual(users.get(1), ada);
    assert.deepEqual(users.findByEmail('ADA@EXAMPLE.COM'), ada);
    assert.equal(users.get(99), null);
    assert.equal(users.findByEmail('missing@example.com'), null);

    const fetched = users.get(1);
    fetched.name = 'Mutated';
    assert.equal(users.get(1).name, 'Ada Lovelace');
    const listed = users.list();
    listed[0].email = 'mutated@example.com';
    listed.push({ id: 99, name: 'Fake', email: 'fake@example.com' });
    assert.equal(users.get(1).email, 'ada@example.com');
    assert.equal(users.get(99), null);

    assert.throws(() => users.create({ name: 'Duplicate', email: 'ADA@example.com' }), Error);
    assert.throws(() => users.create(null), Error);
    assert.throws(() => users.create({ name: '', email: 'empty@example.com' }), Error);
    assert.throws(() => users.create({ name: 'Bad Email', email: 'bad' }), Error);

    const updated = users.update(1, { name: '  Ada Byron  ', email: 'ADA.BYRON@example.com' });
    assert.deepEqual(updated, { id: 1, name: 'Ada Byron', email: 'ada.byron@example.com' });
    assert.deepEqual(users.get(1), updated);
    assert.equal(users.findByEmail('ada@example.com'), null);
    assert.deepEqual(users.findByEmail('ada.byron@example.com'), updated);
    assert.throws(() => users.update(1, { email: 'grace@example.com' }), Error);
    assert.equal(users.get(1).email, 'ada.byron@example.com');
    assert.throws(() => users.update(1, { name: 'x'.repeat(41) }), Error);
    assert.throws(() => users.update(1, { role: 'admin' }), Error);
    assert.throws(() => users.update(99, { name: 'Nobody' }), Error);
    assert.throws(() => users.update(0, {}), Error);
    assert.throws(() => users.update(1, null), Error);

    const third = users.create({ name: 'Third User', email: 'third@example.com' });
    assert.equal(third.id, 3);
    assert.equal(users.remove(99), false);
    assert.equal(users.remove(1), true);
    assert.throws(() => users.remove(0), Error);
    assert.equal(users.findByEmail('ada.byron@example.com'), null);
    assert.deepEqual(users.list(), [grace, third]);
    const fourth = users.create({ name: 'Fourth User', email: 'fourth@example.com' });
    assert.equal(fourth.id, 4);

    return {
      passed: true,
      summary: 'name/email/id validation, normalized creation, duplicate prevention, snapshots, updates, removal, ordering, and non-reused ids passed',
    };
  } catch (error) {
    return { passed: false, summary: error instanceof Error ? error.message : String(error) };
  }
}
