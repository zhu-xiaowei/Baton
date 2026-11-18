import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readCodexModel } from '../../bridge/session-model.mjs';
import { CodexInteraction } from '../../bridge/codex-interaction.mjs';

test('model status uses the last complete turn context and does not infer effort', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-status-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'session.jsonl');
  const row = payload => JSON.stringify({ type: 'turn_context', payload });
  fs.writeFileSync(file, [row({ model: 'model-a', effort: 'high' }),
    row({ model: 'model-b' }), '{incomplete'].join('\n'));
  assert.deepEqual(readCodexModel('s', () => file), {
    model: 'model-b', reasoningEffort: null, source: 'last-known',
  });
  assert.equal(readCodexModel('s', () => path.join(dir, 'missing')), null);
  fs.writeFileSync(file, 'x'.repeat(600_000) + '\n' + row({ model: 'model-c', effort: 'low' }));
  assert.equal(readCodexModel('s', () => file).reasoningEffort, 'low');
});

test('reading live model status never starts or resumes a client', () => {
  const interaction = new CodexInteraction({ clientFactory() { throw new Error('Must not start'); } });
  interaction.sessions.set('a', { model: 'model-a', effort: 'high', client: {} });
  interaction.sessions.set('b', { model: 'model-b', effort: null, client: {} });
  assert.deepEqual(interaction.modelStatus('a'), { model: 'model-a', reasoningEffort: 'high', source: 'live' });
  assert.equal(interaction.modelStatus('b').reasoningEffort, null);
});
