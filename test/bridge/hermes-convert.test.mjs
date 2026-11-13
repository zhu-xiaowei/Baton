import assert from 'node:assert/strict';
import test from 'node:test';
import { convertRow } from '../../bridge/hermes-convert.mjs';

test('Hermes rows keep the sent turn identity and become Baton blocks', () => {
  const meta = JSON.stringify({ submission_id: 'turn-1' });
  assert.deepEqual(convertRow({ id: 1, role: 'user', content: 'hi\n\n[Image attached at: /x.png]\n[Image attached at: /y.png]\n[screenshot]\n[screenshot]', display_metadata: meta, timestamp: 1 }),
    [{ uuid: 'turn-1', type: 'user', content: [{ type: 'text', text: 'hi' }, { type: 'image', path: '/x.png' }, { type: 'image', path: '/y.png' }], timestamp: '1970-01-01T00:00:01.000Z', nativeId: 'live:user:turn-1' }]);
  const steer = '[OUT-OF-BAND USER MESSAGE — a direct message]\nalso add tests\n[/OUT-OF-BAND USER MESSAGE]';
  assert.equal(convertRow({ id: 2, role: 'user', content: steer, display_kind: 'steer' })[0].content[0].text, 'also add tests');
  const calls = JSON.stringify([{ id: 'c1', function: { name: 'tool_call', arguments: JSON.stringify({ calls: [{ name: 'todo_list', arguments: { todos: [] } }] }) } }]);
  assert.equal(convertRow({ id: 3, role: 'assistant', content: '', tool_calls: calls })[0].content[0].name, 'TodoWrite');
  const failed = convertRow({ id: 4, role: 'tool', tool_name: 'terminal', content: JSON.stringify({ output: 'boom\nEXIT=2', exit_code: 0 }) });
  assert.equal(failed[0].content[0].is_error, true);
});
