import assert from 'node:assert/strict';
import test from 'node:test';
import { parseRange } from '../../web/js/media/source.js';

test('ranges are answered whole: no Range is 200, open, closed and suffix ranges are 206', () => {
  assert.deepEqual(parseRange(null, 10), { status: 200, start: 0, end: 10 });
  assert.deepEqual([parseRange('bytes=5-', 10), parseRange('bytes=5-9', 10), parseRange('bytes=-3', 10)].map(r => [r.status, r.start, r.end]),
    [[206, 5, 10], [206, 5, 10], [206, 7, 10]]);
  assert.equal(parseRange('bytes=99-', 10).status, 416);
});
