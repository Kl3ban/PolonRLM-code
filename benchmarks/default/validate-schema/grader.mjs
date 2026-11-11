import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function grade(root) {
  const checks = [];
  const check = (name, fn) => {
    try {
      fn();
      checks.push({ name, ok: true });
    } catch {
      checks.push({ name, ok: false });
    }
  };

  try {
    const { validateSchema } = await import(pathToFileURL(path.join(root, 'src', 'validate-schema.js')).href + `?grade=${Date.now()}`);
    const userSchema = {
      name: { type: 'string', minLength: 1, maxLength: 5 },
      age: { type: 'number', min: 0, max: 150 },
      role: { type: 'string', enum: ['admin', 'user'] },
      active: { type: 'boolean', required: false },
    };

    check('exports validateSchema', () => assert.equal(typeof validateSchema, 'function'));
    check('accepts a fully valid value', () => {
      assert.equal(validateSchema(userSchema, { name: 'Ada', age: 36, role: 'admin', active: true }), true);
    });
    check('accepts an absent optional field', () => {
      assert.equal(validateSchema(userSchema, { name: 'Ada', age: 36, role: 'user' }), true);
      assert.equal(validateSchema({ note: { type: 'string', required: false } }, {}), true);
    });
    check('rejects an absent required field', () => {
      assert.equal(validateSchema(userSchema, { age: 36, role: 'user' }), false);
      assert.equal(validateSchema({ name: { type: 'string' } }, {}), false);
    });
    check('treats undefined and inherited properties as absent', () => {
      assert.equal(validateSchema({ name: { type: 'string' } }, { name: undefined }), false);
      const inherited = Object.create({ name: 'Ada' });
      assert.equal(validateSchema({ name: { type: 'string' } }, inherited), false);
      assert.equal(validateSchema({ name: { type: 'string', required: false } }, inherited), true);
    });
    check('enforces primitive types and finite numbers', () => {
      assert.equal(validateSchema({ v: { type: 'string' } }, { v: 42 }), false);
      assert.equal(validateSchema({ v: { type: 'number' } }, { v: '42' }), false);
      assert.equal(validateSchema({ v: { type: 'boolean' } }, { v: 0 }), false);
      assert.equal(validateSchema({ v: { type: 'number' } }, { v: NaN }), false);
      assert.equal(validateSchema({ v: { type: 'number' } }, { v: Infinity }), false);
    });
    check('applies inclusive number bounds', () => {
      const schema = { v: { type: 'number', min: 0, max: 10 } };
      assert.equal(validateSchema(schema, { v: 0 }), true);
      assert.equal(validateSchema(schema, { v: 10 }), true);
      assert.equal(validateSchema(schema, { v: 9.5 }), true);
      assert.equal(validateSchema(schema, { v: -1 }), false);
      assert.equal(validateSchema(schema, { v: 11 }), false);
      assert.equal(validateSchema({ v: { type: 'number', min: 0 } }, { v: 0 }), true);
    });
    check('applies inclusive string lengths', () => {
      const schema = { v: { type: 'string', minLength: 2, maxLength: 4 } };
      assert.equal(validateSchema(schema, { v: 'ab' }), true);
      assert.equal(validateSchema(schema, { v: 'abcd' }), true);
      assert.equal(validateSchema(schema, { v: 'a' }), false);
      assert.equal(validateSchema(schema, { v: 'abcde' }), false);
      assert.equal(validateSchema({ v: { type: 'string', maxLength: 0 } }, { v: '' }), true);
    });
    check('enforces enum membership with Object.is', () => {
      assert.equal(validateSchema({ v: { type: 'string', enum: ['a', 'b'] } }, { v: 'b' }), true);
      assert.equal(validateSchema({ v: { type: 'string', enum: ['a', 'b'] } }, { v: 'c' }), false);
      assert.equal(validateSchema({ v: { type: 'number', enum: [1, 2] } }, { v: 2 }), true);
      assert.equal(validateSchema({ v: { type: 'number', enum: [0] } }, { v: -0 }), false);
      assert.equal(validateSchema({ v: { type: 'boolean', enum: [true] } }, { v: true }), true);
    });
    check('allows unlisted fields', () => {
      assert.equal(validateSchema({ a: { type: 'string' } }, { a: 'x', extra: 123 }), true);
    });
    check('rejects non-object values', () => {
      for (const value of [null, 42, 'text', true, [], [1]]) {
        assert.equal(validateSchema({}, value), false);
      }
      assert.equal(validateSchema({}, {}), true);
    });
    check('does not mutate the schema or the value', () => {
      const schema = { a: { type: 'string', minLength: 1 } };
      const value = { a: 'x' };
      const schemaBefore = JSON.stringify(schema);
      const valueBefore = JSON.stringify(value);
      assert.equal(validateSchema(schema, value), true);
      assert.equal(JSON.stringify(schema), schemaBefore);
      assert.equal(JSON.stringify(value), valueBefore);
    });
    check('throws TypeError for malformed schemas', () => {
      for (const schema of [null, undefined, [], 'schema', 42]) {
        assert.throws(() => validateSchema(schema, {}), TypeError);
      }
      for (const descriptor of [
        null,
        [],
        {},
        { type: 'integer' },
        { type: 'string', required: 1 },
        { type: 'string', min: 1 },
        { type: 'number', minLength: 1 },
        { type: 'string', minLength: -1 },
        { type: 'string', minLength: 1.5 },
        { type: 'string', minLength: 3, maxLength: 2 },
        { type: 'number', min: 2, max: 1 },
        { type: 'number', min: '0' },
        { type: 'string', enum: [] },
        { type: 'string', enum: ['a', 1] },
        { type: 'boolean', enum: [0] },
        { type: 'string', unknown: true },
      ]) {
        assert.throws(() => validateSchema({ field: descriptor }, { field: 'x' }), TypeError);
      }
    });
  } catch {
    checks.push({ name: 'module loads and runs', ok: false });
  }

  const failed = checks.filter(entry => !entry.ok).map(entry => entry.name);
  const passed = checks.length > 0 && failed.length === 0;
  return {
    passed,
    summary: passed
      ? `${checks.length}/${checks.length} checks passed`
      : `${failed.length}/${checks.length} checks failed: ${failed.slice(0, 4).join('; ')}`,
  };
}
