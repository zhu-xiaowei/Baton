import test from 'node:test';
import assert from 'node:assert/strict';
import { mcpFormReply, mcpFormRequest } from '../../bridge/codex-interaction.mjs';

test('mcp form: number fields keep the form, and only valid numbers are accepted', () => {
  const params = { serverName: 'probe', mode: 'form', requestedSchema: { type: 'object', required: ['name'], properties: {
    name: { type: 'string', format: 'email' }, retries: { type: 'integer', minimum: 0, maximum: 5, default: 2 }, ratio: { type: 'number' } } } };
  const form = mcpFormRequest(params).input.codexMcpElicitation;
  assert.equal(form.responseMode, 'form');
  assert.deepEqual(form.fields[1].input, { type: 'number', integer: true, minimum: 0, maximum: 5, default: 2 });
  const reply = (content) => mcpFormReply(params, { action: 'acceptForm', content });
  assert.deepEqual(reply({ name: 'a@b.co', retries: 3, ratio: 0.5 }), { action: 'accept', content: { name: 'a@b.co', retries: 3, ratio: 0.5 } });
  assert.deepEqual(reply({ name: 'a@b.co', retries: 9 }), { action: 'cancel' });
  assert.deepEqual(reply({ name: 'a@b.co', retries: 1.5 }), { action: 'cancel' });
});
