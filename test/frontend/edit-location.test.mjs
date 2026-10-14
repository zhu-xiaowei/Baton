import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveEditLocation } from '../../web/js/project/edit-location.js';

test('separate changed blocks locate independently despite unrelated file edits', async () => {
  const between = Array.from({ length: 12 }, (_, index) => `unchanged ${index}`).join('\n');
  const input = {
    old_string: `start\nbefore A\n${between}\nbefore B\nend`,
    new_string: `start\nafter A\n${between}\nafter B\nend`,
  };
  const current = `extra first line\n${input.new_string}`.replace('unchanged 5', 'later unrelated edit');
  const result = await resolveEditLocation(current, input, 'v1');
  assert.deepEqual(result.ranges, [{ from: 3, to: 3 }, { from: 16, to: 16 }]);
});

test('unchanged file versions reuse ranges and changed versions relocate', async () => {
  const input = { old_string: 'old', new_string: 'new' };
  const initial = await resolveEditLocation('head\nnew\ntail', input, 'v1');
  assert.deepEqual(initial.ranges, [{ from: 2, to: 2 }]);
  assert.equal(await resolveEditLocation('head\nnew\ntail', input, 'v1', initial), initial);
  const moved = await resolveEditLocation('extra\nhead\nnew\ntail', input, 'v2', initial);
  assert.deepEqual(moved.ranges, [{ from: 3, to: 3 }]);
});

test('ambiguous or missing blocks never choose an arbitrary first occurrence', async () => {
  const input = { old_string: 'old', new_string: 'new' };
  assert.deepEqual((await resolveEditLocation('new\nmiddle\nnew', input, 'duplicate')).ranges, []);
  assert.deepEqual((await resolveEditLocation('something else', input, 'missing')).ranges, []);
});

test('context distinguishes repeated changed lines and tolerates indentation changes', async () => {
  const input = { old_string: 'context\nold\nend', new_string: 'context\nnew\nend' };
  const current = 'other\nnew\nsection\n  context\n  new\n  end';
  assert.deepEqual((await resolveEditLocation(current, input, 'v1')).ranges, [{ from: 5, to: 5 }]);
});

test('only surviving blocks are highlighted after later edits replace part of the change', async () => {
  const middle = Array.from({ length: 10 }, (_, index) => `same ${index}`).join('\n');
  const input = {
    old_string: `start\nold A\n${middle}\nold B\nend`,
    new_string: `start\nnew A\n${middle}\nnew B\nend`,
  };
  const current = input.new_string.replace('new A', 'different later edit');
  assert.deepEqual((await resolveEditLocation(current, input, 'v2')).ranges, [{ from: 13, to: 13 }]);
});

test('deletions locate a unique context boundary and empty contexts do not guess', async () => {
  const input = { old_string: 'head\nremoved\ntail', new_string: 'head\ntail' };
  assert.deepEqual((await resolveEditLocation('extra\nhead\ntail', input, 'v1')).ranges, [
    { from: 3, to: 3, deletion: true },
  ]);
  assert.deepEqual((await resolveEditLocation('unrelated', { old_string: 'removed', new_string: '' }, 'v2')).ranges, []);
});
