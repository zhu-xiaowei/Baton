import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePreviewInput, parsePreviewTarget } from '../../web/js/preview-link.js';

test('local service links preserve port, path and query for the selected device', () => {
  assert.deepEqual(parsePreviewTarget('http://localhost:8000/admin?a=1#top'), {
    port: 8000, pathname: '/admin', search: '?a=1', hash: '#top',
    displayUrl: 'http://localhost:8000/admin?a=1#top',
  });
  assert.equal(parsePreviewTarget('http://127.0.0.1/').port, 80);
  assert.equal(parsePreviewInput('5173').port, 5173);
  assert.equal(parsePreviewInput('localhost:8080/test').pathname, '/test');
  assert.equal(parsePreviewTarget('http://[::1]:3000/').port, 3000);
});

test('remote hosts and non-browser protocols do not become preview tunnels', () => {
  for (const value of [
    'http://example.com:3000/', 'http://169.254.169.254/', 'http://127.0.0.2:3000/',
    'https://localhost:3000/', 'file:///tmp/page.html', 'http://localhost:0/',
    'http://localhost:65536/', 'http://user:pass@localhost:3000/',
  ]) {
    assert.equal(parsePreviewTarget(value), null, value);
  }
});
