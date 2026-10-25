import assert from 'node:assert/strict';
import test from 'node:test';
import { locate, tokenize } from '../src/lesson-kit/code.ts';

const kinds = (line) => line.filter((t) => t.text.trim()).map((t) => [t.text.trim(), t.kind]);

test('an entity reads like it does in Fabricator’s editor', () => {
  const [decorator, field, policy, klass] = tokenize(`@role('authenticated', '*', {
  @text({ max: 200 }) title!: string;
  policy: (claims, item) => claims.sub.eq(item.owner_id),
export class Expense {`);
  assert.deepEqual(kinds(decorator), [
    ['@role', 'decorator'],
    ['(', 'bracket'],
    ["'authenticated'", 'string'],
    [',', 'punct'],
    ["'*'", 'string'],
    [',', 'punct'],
    ['{', 'bracket'],
  ]);
  assert.deepEqual(kinds(field), [
    ['@text', 'decorator'],
    ['(', 'bracket'],
    ['{', 'bracket'],
    ['max', 'property'],
    [':', 'punct'],
    ['200', 'number'],
    ['}', 'bracket'],
    [')', 'bracket'],
    ['title', 'property'],
    ['!:', 'punct'],
    ['string', 'keyword'],
    [';', 'punct'],
  ]);
  const p = kinds(policy);
  assert.deepEqual(p[0], ['policy', 'property']);
  assert.deepEqual(
    p.filter(([, k]) => k === 'property' || k === 'function').map(([t]) => t),
    ['policy', 'sub', 'eq', 'owner_id'],
  );
  assert.deepEqual(kinds(klass), [
    ['export', 'keyword'],
    ['class', 'keyword'],
    ['Expense', 'type'],
    ['{', 'bracket'],
  ]);
});

test('brackets are colored by how deeply they nest', () => {
  const [line] = tokenize('a({ b: [1] })');
  const depths = line.filter((t) => t.kind === 'bracket').map((t) => [t.text, t.depth]);
  assert.deepEqual(depths, [
    ['(', 0],
    ['{', 1],
    ['[', 2],
    [']', 2],
    ['}', 1],
    [')', 0],
  ]);
});

test('comments and strings win over everything inside them', () => {
  const [a, b, c] = tokenize("const s = '@entity() // no'; // @role\n/* a\nclass */ x");
  assert.deepEqual(kinds(a).slice(-3), [
    ["'@entity() // no'", 'string'],
    [';', 'punct'],
    ['// @role', 'comment'],
  ]);
  assert.deepEqual(kinds(b), [['/* a', 'comment']]);
  assert.deepEqual(kinds(c), [
    ['class */', 'comment'],
    ['x', 'plain'],
  ]);
});

test('locate finds text by line and column, or says it is gone', () => {
  const code = 'one\n  two two\nthree';
  assert.deepEqual(locate(code, 'two'), { line: 2, from: 2, to: 5 });
  assert.deepEqual(locate(code, 'two', 2), { line: 2, from: 6, to: 9 });
  assert.throws(() => locate(code, 'four'), /"four" \(#1\) isn't in the snippet/);
});

test('YAML reads like it does in Fabricator’s editor: keys, values, booleans, lists and comments', () => {
  const [top, nested, flag, item, url, command, comment, number] = tokenize(
    `id: my-app
    assetAccess: protected
    enabled: false
  - name: sales_warehouse
      - http://localhost:5173
    buildCommand: npm run build:fabric # the frontend
# Generated
    port: 5173`,
    'yaml',
  );
  assert.deepEqual(kinds(top), [
    ['id', 'type'],
    [':', 'punct'],
    ['my-app', 'string'],
  ]);
  assert.deepEqual(kinds(nested), [
    ['assetAccess', 'type'],
    [':', 'punct'],
    ['protected', 'string'],
  ]);
  assert.deepEqual(kinds(flag).at(-1), ['false', 'keyword']);
  assert.deepEqual(kinds(item), [
    ['-', 'punct'],
    ['name', 'type'],
    [':', 'punct'],
    ['sales_warehouse', 'string'],
  ]);
  assert.deepEqual(kinds(url), [
    ['-', 'punct'],
    ['http://localhost:5173', 'string'],
  ]);
  assert.deepEqual(kinds(command), [
    ['buildCommand', 'type'],
    [':', 'punct'],
    ['npm run build:fabric', 'string'],
    ['# the frontend', 'comment'],
  ]);
  assert.deepEqual(kinds(comment), [['# Generated', 'comment']]);
  assert.deepEqual(kinds(number).at(-1), ['5173', 'number']);
  // Every character is kept, so marks found with locate() land on the code.
  assert.equal(command.map((t) => t.text).join(''), '    buildCommand: npm run build:fabric # the frontend');
});

test('JSON keys are told apart from string values', () => {
  const [line] = tokenize('  "hostingUrl": "https://example.net", "n": 1, "on": true', 'json');
  assert.deepEqual(kinds(line), [
    ['"hostingUrl"', 'property'],
    [':', 'punct'],
    ['"https://example.net"', 'string'],
    [',', 'punct'],
    ['"n"', 'property'],
    [':', 'punct'],
    ['1', 'number'],
    [',', 'punct'],
    ['"on"', 'property'],
    [':', 'punct'],
    ['true', 'keyword'],
  ]);
});
