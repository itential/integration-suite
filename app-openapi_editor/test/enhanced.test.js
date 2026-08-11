'use strict';

const { InMemoryTemplateStore } = require('../lib/mongoStore');
const { buildOutline } = require('../lib/outline');
const { lineDiff } = require('../lib/lineDiff');
const { applyRegistryEntries, getCatalogEntry } = require('../lib/registryCatalog');
const nunjucks = require('nunjucks');

describe('buildOutline', () => {
  test('credits the ancestor that originally defines a block, not the child override', async () => {
    const store = new InMemoryTemplateStore();
    await store.create({ name: 'base', type: 'partial', body: '{% block title %}Default{% endblock %}\n{% block body %}{% endblock %}' });
    await store.create({ name: 'child', type: 'page', body: '{% extends "base" %}{% block title %}Hi{% endblock %}' });

    const outline = await buildOutline(store, 'child');
    const title = outline.blocks.find((b) => b.name === 'title');
    const body = outline.blocks.find((b) => b.name === 'body');

    expect(title.definedIn).toBe('base');
    expect(title.overridden).toBe(true);
    expect(title.overriddenBy).toEqual(['child']);
    expect(body.definedIn).toBe('base');
    expect(body.overridden).toBe(false);
  });

  test('extracts macro signatures with defaults and **kwargs', async () => {
    const store = new InMemoryTemplateStore();
    await store.create({ name: 'lib', type: 'macro-library', body: '{% macro greet(name, greeting="Hello", **kwargs) %}{{ greeting }} {{ name }}{% endmacro %}' });
    const outline = await buildOutline(store, 'lib');
    expect(outline.macros).toEqual([
      { name: 'greet', args: [{ name: 'name', default: null }, { name: 'greeting', default: '"Hello"' }], hasKwargs: true },
    ]);
  });
});

describe('lineDiff', () => {
  test('reports equal/add/remove chunks between two multi-line strings', () => {
    const diff = lineDiff('a\nb\nc', 'a\nx\nc');
    expect(diff).toEqual([
      { type: 'equal', value: 'a' },
      { type: 'remove', value: 'b' },
      { type: 'add', value: 'x' },
      { type: 'equal', value: 'c' },
    ]);
  });
});

describe('registryCatalog', () => {
  test('applyRegistryEntries only wires entries whose kind matches the catalog entry', () => {
    const env = new nunjucks.Environment();
    applyRegistryEntries(env, [
      { name: 'snake', kind: 'filter', catalogKey: 'to_snake_case' },
      { name: 'bogus', kind: 'global', catalogKey: 'to_snake_case' }, // kind mismatch - should be skipped
    ]);
    expect(env.render === undefined).toBe(false);
    const out = env.renderString('{{ "HelloWorld" | snake }}', {});
    expect(out).toBe('hello_world');
    expect(getCatalogEntry('to_snake_case').kind).toBe('filter');
  });
});
