import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { JSDOM } from 'jsdom';

const ROOT = path.resolve(import.meta.dirname, '../..');
const indexHtml = fs.readFileSync(path.join(ROOT, 'web/index.html'), 'utf8');

test('New Project only collects a directory path', () => {
  const dom = new JSDOM(indexHtml);
  const modal = dom.window.document.getElementById('newProjectModal');

  assert.ok(modal);
  assert.equal(modal.querySelector('#newProjectAsAgent'), null);
  assert.equal(modal.textContent.includes('Claude Agents Run in background'), false);
  assert.ok(modal.querySelector('#newProjectInput'));
});
