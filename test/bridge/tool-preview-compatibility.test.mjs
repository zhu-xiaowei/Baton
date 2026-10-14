import assert from 'node:assert/strict';
import test from 'node:test';
import { configureToolPreviews, prepareToolMessages } from '../../bridge/tool-preview.mjs';
import { LiveTurnStream } from '../../bridge/live-turn-stream.mjs';
import { uploadMessages } from '../../bridge/extract.mjs';
import { deliverRealtimeMessages } from '../../bridge/realtime-delivery.mjs';
import { initHttp } from '../../bridge/http.mjs';

test('existing clients retain complete data unless preview storage is explicitly enabled', async () => {
  const source = { uuid: 'edit', type: 'assistant', content: [{
    type: 'tool_use', id: 'edit', name: 'Edit',
    input: { file_path: '/file', old_string: 'old'.repeat(1000), new_string: 'new'.repeat(1000) },
  }] };
  assert.equal(prepareToolMessages([source])[0], source);
  const sent = [];
  const stream = new LiveTurnStream({ sessionId: 's', turnId: 't', send: event => sent.push(event) });
  stream.sendBlockStart({ blockId: 1, kind: 'tool_use', name: 'Edit' });
  const json = JSON.stringify(source.content[0].input);
  stream.sendToolInput({ blockId: 1, chunk: json });
  stream.sendAuthoritative(source);
  stream.sendEnd();
  assert.equal(sent.find(event => event.action === 'stream_tool_input').chunk, json);
  assert.deepEqual(sent.at(-1).messages[0], source);
  const requests = [];
  initHttp({ server: 'https://test', apiKey: 'test' });
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return { ok: true };
  };
  try {
    await uploadMessages('s', [source]);
    assert.deepEqual(requests[0].messages[0], source);
    await deliverRealtimeMessages('s', [source], {
      wsSendWithAckFn: async event => {
        assert.deepEqual(event.messages[0], source);
        return true;
      },
    });
  } finally { globalThis.fetch = previousFetch; }
  configureToolPreviews(true);
  try {
    assert.deepEqual(prepareToolMessages([source])[0].content[0].input, { file_path: '/file' });
  } finally { configureToolPreviews(false); }
});
