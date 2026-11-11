import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

export async function grade(workspace) {
  try {
    const mod = await import(pathToFileURL(`${workspace}/src/index.js`).href + `?grade=${Date.now()}`);
    const { escapeCell, formatCell, serializeCsv } = mod;
    for (const fn of [escapeCell, formatCell, serializeCsv]) {
      assert.equal(typeof fn, 'function');
    }

    assert.equal(formatCell(null), '');
    assert.equal(formatCell(undefined), '');
    assert.equal(formatCell('text'), 'text');
    assert.equal(formatCell(true), 'true');
    assert.equal(formatCell(false), 'false');
    assert.equal(formatCell(0), '0');
    assert.equal(formatCell(-12.5), '-12.5');
    assert.throws(() => formatCell(Number.NaN), Error);
    assert.throws(() => formatCell(Number.POSITIVE_INFINITY), Error);
    assert.throws(() => formatCell({}), Error);
    assert.throws(() => formatCell([1]), Error);
    assert.throws(() => formatCell(1n), Error);

    assert.equal(escapeCell('plain'), 'plain');
    assert.equal(escapeCell('a,b'), '"a,b"');
    assert.equal(escapeCell('a"b'), '"a""b"');
    assert.equal(escapeCell('a\nb'), '"a\nb"');
    assert.equal(escapeCell('a\rb'), '"a\rb"');
    assert.equal(escapeCell(''), '');

    const headers = ['name', 'age'];
    const rows = [
      ['Ada', 36],
      ['Grace', null],
    ];
    const headersBefore = [...headers];
    const rowsBefore = structuredClone(rows);
    const basic = serializeCsv(headers, rows);
    assert.equal(basic, 'name,age\nAda,36\nGrace,');
    assert.ok(!basic.endsWith('\n'));
    assert.deepEqual(headers, headersBefore);
    assert.deepEqual(rows, rowsBefore);

    assert.equal(
      serializeCsv(['full,name', 'note'], [['Doe, Jane', 'She said "hi"\nOK']]),
      '"full,name",note\n"Doe, Jane","She said ""hi""\nOK"',
    );
    assert.equal(
      serializeCsv(['a', 'b', 'c', 'd'], [['x,y', 0, false, undefined]]),
      'a,b,c,d\n"x,y",0,false,',
    );
    assert.equal(serializeCsv(['line\nbreak'], []), '"line\nbreak"');

    assert.throws(() => serializeCsv([], []), Error);
    assert.throws(() => serializeCsv(null, []), Error);
    assert.throws(() => serializeCsv(['a', 'a'], []), Error);
    assert.throws(() => serializeCsv(['a', ''], []), Error);
    assert.throws(() => serializeCsv(['a', 2], []), Error);
    assert.throws(() => serializeCsv(['a'], null), Error);
    assert.throws(() => serializeCsv(['a'], [['too', 'wide']]), Error);
    assert.throws(() => serializeCsv(['a'], [['narrow']].concat([null])), Error);
    assert.throws(() => serializeCsv(['a'], [[{}]]), Error);
    assert.throws(() => serializeCsv(['a'], [[Number.NaN]]), Error);

    return {
      passed: true,
      summary: 'cell formatting, quote/comma/newline escaping, headers, width validation, empty rows, unsupported value rejection, and immutability passed',
    };
  } catch (error) {
    return { passed: false, summary: error instanceof Error ? error.message : String(error) };
  }
}
