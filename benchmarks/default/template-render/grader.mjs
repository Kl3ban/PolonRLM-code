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
    const { render } = await import(pathToFileURL(path.join(root, 'src', 'template-render.js')).href + `?grade=${Date.now()}`);
    check('exports render', () => assert.equal(typeof render, 'function'));
    check('replaces simple and repeated placeholders', () => {
      assert.equal(render('Hello, {{ name }}!', { name: 'Ada' }), 'Hello, Ada!');
      assert.equal(render('{{a}}/{{b}}/{{a}}', { a: 1, b: 2 }), '1/2/1');
    });
    check('accepts whitespace inside placeholders', () => {
      assert.equal(render('{{a}}{{ a }}{{\ta\t}}{{\n a \n}}', { a: 'x' }), 'xxxx');
    });
    check('resolves dotted paths through objects and arrays', () => {
      assert.equal(render('{{user.name}}', { user: { name: 'Ada' } }), 'Ada');
      assert.equal(render('{{ a.b.c }}', { a: { b: { c: 3 } } }), '3');
      assert.equal(render('{{ items.1 }}', { items: ['x', 'y'] }), 'y');
      assert.equal(render('{{ items.0.label }}', { items: [{ label: 'first' }] }), 'first');
    });
    check('stringifies edge values', () => {
      assert.equal(render('{{v}}', { v: null }), 'null');
      assert.equal(render('{{v}}', { v: 0 }), '0');
      assert.equal(render('{{v}}', { v: false }), 'false');
      assert.equal(render('{{v}}', { v: '' }), '');
      assert.equal(render('{{v}}', { v: 'é' }), 'é');
    });
    check('does not rescan inserted text', () => {
      assert.equal(render('{{a}}', { a: '{{b}}', b: 'x' }), '{{b}}');
    });
    check('leaves malformed placeholders untouched', () => {
      for (const template of ['{{}}', '{{ }}', '{{a b}}', '{{a.}}', '{{.a}}', '{{a..b}}', '{ {a} }', '{{a', 'a}}', 'plain']) {
        assert.equal(render(template, { a: 1, b: 2 }), template);
      }
    });
    check('throws TypeError for missing values', () => {
      assert.throws(() => render('{{missing}}', {}), TypeError);
      assert.throws(() => render('{{user.name}}', { user: {} }), TypeError);
      assert.throws(() => render('{{user.name}}', { user: null }), TypeError);
      assert.throws(() => render('{{v}}', { v: undefined }), TypeError);
    });
    check('only reads own properties', () => {
      const data = Object.create({ name: 'Inherited' });
      assert.throws(() => render('{{name}}', data), TypeError);
    });
    check('rejects an invalid template or data', () => {
      for (const template of [undefined, null, 42, {}, []]) {
        assert.throws(() => render(template, {}), TypeError);
      }
      for (const data of [undefined, null, 'text', 42, true]) {
        assert.throws(() => render('plain', data), TypeError);
      }
    });
    check('renders an empty template', () => {
      assert.equal(render('', {}), '');
      assert.equal(render('', []), '');
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
