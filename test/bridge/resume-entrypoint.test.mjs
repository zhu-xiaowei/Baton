import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { exposeToResumePicker } from '../../bridge/jsonl.mjs';

test('new headless session is exposed to /resume by an equal-length head rewrite', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-entrypoint-'));
  const filePath = path.join(dir, 'session.jsonl');
  const lines = [
    { type: 'queue-operation', operation: 'enqueue' },
    { type: 'user', uuid: 'u1', message: { content: 'say "entrypoint":"sdk-cli"' }, entrypoint: 'sdk-cli' },
    { type: 'assistant', uuid: 'a1', entrypoint: 'sdk-cli' },
  ];
  const original = lines.map((line) => JSON.stringify(line)).join('\n') + '\n';
  fs.writeFileSync(filePath, original);

  assert.equal(exposeToResumePicker(filePath), true);
  const patched = fs.readFileSync(filePath, 'utf8');
  assert.equal(Buffer.byteLength(patched), Buffer.byteLength(original));
  const rows = patched.trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(rows[1].entrypoint, 'cli');
  assert.equal(rows[1].message.content, 'say "entrypoint":"sdk-cli"');
  assert.equal(rows[2].entrypoint, 'sdk-cli');

  assert.equal(exposeToResumePicker(filePath), false);
  assert.equal(fs.readFileSync(filePath, 'utf8'), patched);
  fs.rmSync(dir, { recursive: true, force: true });
});
