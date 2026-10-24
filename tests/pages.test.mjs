// Pages in the center (Jobs, Apps, Pull requests, Skills, Settings) share their layout through one class, so a
// new page cannot come out half-styled (with the terminals' tab bar above it, or see-through in the sky theme).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const css = await readFile(new URL('../public/style.css', import.meta.url), 'utf8');
const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');

test('every page in the center is a page-view with a name', () => {
  const pages = [...html.matchAll(/<section id="([a-z]+-view)"([^>]*)>/g)];
  assert.ok(pages.length >= 5);
  for (const [, id, attrs] of pages) {
    assert.match(attrs, /class="[^"]*\bpage-view\b/, `${id} needs class page-view`);
    assert.match(attrs, /aria-label="[^"]+"/, `${id} needs aria-label (it is the page title)`);
  }
});

test('page layout lives on the class, not on each page', () => {
  assert.match(css, /body:has\(\.page-view:not\(\.hidden\)\) #tabbar/);
  assert.match(css, /\.page-view \{ position: absolute; inset: 0;/);
  // Rules about "a page is open" go through the class: listing pages one by one is how a new one gets left out.
  for (const id of ['job-view', 'app-view', 'pr-view', 'skill-view', 'settings-view']) {
    assert.doesNotMatch(css, new RegExp(`#${id} \\{ position: absolute`), `${id} repeats the page layout`);
    assert.doesNotMatch(css, new RegExp(`#${id}:not\\(\\.hidden\\)`), `a rule names ${id} instead of .page-view`);
  }
});

test('sky stacks only the outer panes, leaving nested pages positioned and scrollable', () => {
  assert.match(css, /body\.night > :is\(aside, section, main\) \{ position: relative; z-index: 1; \}/);
  assert.doesNotMatch(css, /body\.night (?:aside|section|main)[^{]*\{[^}]*position: relative/);
});

test('every page can be closed by closePages, so going to a session never leaves one open', () => {
  const closers = app.slice(app.indexOf('const PAGE_CLOSERS = {'), app.indexOf('function closePages('));
  for (const [, id] of html.matchAll(/<section id="([a-z]+-view)"/g)) assert.match(closers, new RegExp(`'${id}':`), `${id} is missing from PAGE_CLOSERS`);
  // Going to a session from the reply list or from search closes pages first.
  for (const marker of ["$('#reply-inbox-list').addEventListener", 'function chooseGlobalHit(', 'async function openSession(']) {
    const body = app.slice(app.indexOf(marker), app.indexOf(marker) + 900);
    assert.match(body, /closePages\(/, `${marker} does not close pages`);
  }
});
