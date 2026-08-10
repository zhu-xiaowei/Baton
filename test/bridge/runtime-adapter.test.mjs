import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import test from 'node:test';
import { claudeRuntime } from '../../bridge/claude-runtime.mjs';
import { codexRuntime } from '../../bridge/codex-runtime.mjs';
import { decodeSyncedState } from '../../bridge/extract.mjs';
import { scanJsonlLines } from '../../bridge/jsonl.mjs';
import { defineRuntimeAdapter } from '../../bridge/runtime-adapter.mjs';
import {
  detectRegisteredRuntimeCapabilities,
  getRuntimeAdapter,
  runtimeAdapters,
} from '../../bridge/runtime-registry.mjs';
import { getSessionMetadata } from '../../bridge/session.mjs';

function claudeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentpeek-claude-runtime-'));
  const filePath = path.join(root, 'session.jsonl');
  fs.writeFileSync(filePath, [
    JSON.stringify({
      type: 'user',
      uuid: 'user-1',
      timestamp: '2026-08-06T00:00:00.000Z',
      message: { content: 'First prompt' },
    }),
    JSON.stringify({
      type: 'assistant',
      uuid: 'assistant-1',
      timestamp: '2026-08-06T00:00:01.000Z',
      message: {
        model: 'claude-test',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Done' }],
      },
    }),
    '',
  ].join('\n'));
  return { root, filePath };
}

test('runtime registry exposes one validated adapter per runtime', () => {
  assert.deepEqual(runtimeAdapters.map((adapter) => adapter.runtime), ['claude', 'codex']);
  assert.equal(getRuntimeAdapter('claude'), claudeRuntime);
  assert.equal(getRuntimeAdapter('codex'), codexRuntime);
  assert.equal(getRuntimeAdapter('unknown'), claudeRuntime);
  assert.equal(claudeRuntime.features.send, true);
  assert.equal(codexRuntime.features.send, false);
  assert.throws(
    () => defineRuntimeAdapter({ runtime: 'broken' }),
    /requires discover/,
  );
  assert.throws(
    () => defineRuntimeAdapter({
      ...codexRuntime,
      runtime: 'broken-delete',
      features: { deleteHistory: true },
      deleteSessionHistory: undefined,
    }),
    /requires deleteSessionHistory/,
  );
});

test('capability detection is dispatched through runtime adapters', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentpeek-capabilities-'));
  const claudeProjects = path.join(root, 'claude-projects');
  const codexHome = path.join(root, 'codex');
  fs.mkdirSync(claudeProjects);
  fs.mkdirSync(path.join(codexHome, 'sessions'), { recursive: true });
  try {
    const capabilities = detectRegisteredRuntimeCapabilities({
      claude: {
        claudeProjects,
        claudeBin: '/fake/claude',
        skipVersions: true,
      },
      codex: {
        codexHomes: [codexHome],
        codexBin: '/fake/codex',
        skipVersions: true,
      },
    });
    assert.equal(capabilities.claude.canCreate, true);
    assert.equal(capabilities.codex.canRead, true);
    assert.equal(capabilities.codex.canCreate, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Claude metadata scan returns preview, latest model, and line count in one result', () => {
  const { root, filePath } = claudeFixture();
  try {
    assert.deepEqual(getSessionMetadata(filePath), {
      preview: 'First prompt',
      model: 'claude-test',
      lineCount: 2,
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('chunked JSONL scan preserves UTF-8, CRLF, and line numbering', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentpeek-jsonl-'));
  const filePath = path.join(root, 'sample.jsonl');
  fs.writeFileSync(filePath, 'alpha\n中文\r\nomega\n');
  try {
    const lines = [];
    const lineCount = scanJsonlLines(
      filePath,
      (line, index) => lines.push([index, line]),
      { chunkSize: 2 },
    );
    assert.equal(lineCount, 3);
    assert.deepEqual(lines, [[0, 'alpha'], [1, '中文'], [2, 'omega']]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Claude adapter commits its watermark only after upload succeeds', async () => {
  const { root, filePath } = claudeFixture();
  const watermarks = new Map();
  const session = {
    nativeSessionId: 'session',
    _filePath: filePath,
  };
  try {
    await assert.rejects(
      claudeRuntime.syncInitialMessages(session, {
        storageSessionId: 'session',
        watermarks,
        uploader: async () => { throw new Error('upload failed'); },
      }),
      /upload failed/,
    );
    assert.equal(watermarks.has('session'), false);

    let uploaded = 0;
    const result = await claudeRuntime.syncInitialMessages(session, {
      storageSessionId: 'session',
      watermarks,
      uploader: async (_sessionId, messages) => { uploaded += messages.length; },
    });
    assert.equal(uploaded, 2);
    assert.equal(result.messages.length, 2);
    assert.equal(watermarks.get('session'), 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('legacy watermark migration replays one Claude line but preserves v2 values', () => {
  assert.deepEqual(
    Object.fromEntries(decodeSyncedState({ claude: 10, 'codex:thread': 20 })),
    { claude: 9, 'codex:thread': 20 },
  );
  assert.deepEqual(
    Object.fromEntries(decodeSyncedState({
      version: 2,
      watermarks: { claude: 10, 'codex:thread': 20 },
    })),
    { claude: 10, 'codex:thread': 20 },
  );
});
