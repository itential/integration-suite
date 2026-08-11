'use strict';

const { InMemoryTemplateStore } = require('../lib/mongoStore');
const { render } = require('../lib/nunjucksLoader');

describe('StoreLoader chain resolution', () => {
  let store;

  beforeEach(() => {
    store = new InMemoryTemplateStore();
  });

  test('resolves {% extends %} against a stored base template', async () => {
    await store.create({
      name: 'base',
      type: 'page',
      body: 'Header\n{% block content %}default{% endblock %}\nFooter'
    });
    await store.create({
      name: 'child',
      type: 'page',
      body: '{% extends "base" %}\n{% block content %}Hello {{ user }}{% endblock %}'
    });

    const output = await render(store, 'child', { user: 'Ada' }, {});
    expect(output).toContain('Header');
    expect(output).toContain('Hello Ada');
    expect(output).toContain('Footer');
  });

  test('resolves {% include %} pulling in a stored partial', async () => {
    await store.create({
      name: 'partials/greeting',
      type: 'partial',
      body: 'Hi, {{ user }}!'
    });
    await store.create({
      name: 'page-with-include',
      type: 'page',
      body: 'Start\n{% include "partials/greeting" %}\nEnd'
    });

    const output = await render(store, 'page-with-include', { user: 'Grace' }, {});
    expect(output).toContain('Start');
    expect(output).toContain('Hi, Grace!');
    expect(output).toContain('End');
  });

  test('resolves {% import ... as %} exposing macros from a stored macro-library', async () => {
    await store.create({
      name: 'macros/lib',
      type: 'macro-library',
      body: '{% macro shout(name) %}HELLO {{ name | upper }}!{% endmacro %}'
    });
    await store.create({
      name: 'page-with-import',
      type: 'page',
      body: '{% import "macros/lib" as lib %}{{ lib.shout(user) }}'
    });

    const output = await render(store, 'page-with-import', { user: 'ada' }, {});
    expect(output).toBe('HELLO ADA!');
  });

  test('resolves a diamond dependency (same partial included from two paths) without a false circular error', async () => {
    await store.create({ name: 'shared/partial', type: 'partial', body: 'shared-bit' });
    await store.create({
      name: 'left',
      type: 'partial',
      body: 'left[{% include "shared/partial" %}]'
    });
    await store.create({
      name: 'right',
      type: 'partial',
      body: 'right[{% include "shared/partial" %}]'
    });
    await store.create({
      name: 'diamond-top',
      type: 'page',
      body: '{% include "left" %}-{% include "right" %}'
    });

    const output = await render(store, 'diamond-top', {}, {});
    expect(output).toBe('left[shared-bit]-right[shared-bit]');
  });

  test('honors name@vN version pinning, falling back to latest when unpinned', async () => {
    const doc = await store.create({ name: 'versioned', type: 'partial', body: 'v1-body' });
    await store.update(doc._id, { body: 'v2-body' });

    // build a wrapper referencing pinned v1 and unpinned (latest)
    await store.create({
      name: 'wrapper',
      type: 'page',
      body: '{% include "versioned@v1" %}|{% include "versioned" %}'
    });
    const output = await render(store, 'wrapper', {}, {});
    expect(output).toBe('v1-body|v2-body');
  });

  test('throws a clear circular reference error for a two-template cycle (A extends B, B extends A)', async () => {
    await store.create({ name: 'A', type: 'page', body: '{% extends "B" %}' });
    await store.create({ name: 'B', type: 'page', body: '{% extends "A" %}' });

    await expect(render(store, 'A', {}, {})).rejects.toThrow(/circular reference/);
  });

  test('throws a clear circular reference error for a longer include cycle (A -> B -> A)', async () => {
    await store.create({ name: 'A', type: 'partial', body: 'a-start {% include "B" %} a-end' });
    await store.create({ name: 'B', type: 'partial', body: 'b-start {% include "A" %} b-end' });

    let caught = null;
    try {
      await render(store, 'A', {}, {});
    } catch (err) {
      caught = err;
    }
    expect(caught).not.toBeNull();
    expect(caught.message).toMatch(/circular reference/);
    expect(caught.message).toContain('A -> B -> A');
  });

  test('throws a not-found error for a missing referenced template', async () => {
    await store.create({ name: 'lonely', type: 'page', body: '{% include "does-not-exist" %}' });
    await expect(render(store, 'lonely', {}, {})).rejects.toThrow(/not found/);
  });
});
