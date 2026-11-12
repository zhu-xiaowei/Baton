// "Yes, for this session" grants by storage Session id. Harnesses keep them only in the process,
// so the Bridge hands them back on every start (Claude: --allowedTools).
import fs from 'fs';
import path from 'path';
import { BRIDGE_HOME } from './config.mjs';

export class SessionGrants {
  constructor(file = path.join(BRIDGE_HOME, 'session-grants.json')) {
    this.file = file;
    try { this.grants = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { this.grants = {}; }
  }

  get(sessionId) {
    return this.grants[sessionId] || [];
  }

  add(sessionId, rules) {
    this.grants[sessionId] = [...new Set([...this.get(sessionId), ...rules])];
    this.save();
  }

  forget(sessionId) {
    if (!(sessionId in this.grants)) return;
    delete this.grants[sessionId];
    this.save();
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.grants), { mode: 0o600 });
    } catch (error) {
      console.error(`[grants] ${error.message}`);
    }
  }
}
