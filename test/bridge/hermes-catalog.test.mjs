import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
test('a Hermes Session row is as large as its stored message content', async () => {
  process.env.HERMES_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-'));
  const db = new DatabaseSync(path.join(process.env.HERMES_HOME, 'state.db'));
  db.exec(`CREATE TABLE sessions (id TEXT, source TEXT, title TEXT, message_count INT, started_at REAL);
    CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, timestamp REAL);
    INSERT INTO sessions VALUES ('s1', 'tui', 'T', 2, 1); INSERT INTO messages VALUES (1, 's1', 'user', 'hé', 1), (2, 's1', 'assistant', 'ok', 2);`);
  const { catalog } = await import('../../bridge/hermes-catalog.mjs');
  assert.equal(catalog.refresh(null).upserts[0].size, 5);
});
