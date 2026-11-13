// DSH interaction over ACP (`dsh --profile acp`): a send starts one process for the Session, later
// sends queue in it (ACP admits one prompt at a time), and it exits once the queue is empty (§6.6).
// ACP sends whole blocks; the rows themselves come from the log watcher (deliver), so live rows and
// history are the same rows.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { BRIDGE_HOME } from './config.mjs';
import { RpcStdio } from './rpc-stdio.mjs';
import { finishProcess, sessionProcess } from './turn-process.mjs';
import { commonDirs, pickNode } from './runtime-bin.mjs';
import { SessionGrants } from './session-grants.mjs';
import { StreamFramer } from './stream-framer.mjs';
import { defineInteractionAdapter } from './interaction-adapter.mjs';
import { sessionIndex } from './session-index.mjs';
import { mapTool } from './dsh-extract.mjs';
import { catalog, DSH_HOME, LOG, readdir, SESSIONS } from './dsh-catalog.mjs';
import { lockHolder, refreshLocks } from './dsh-locks.mjs';

const IMAGE_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };
const grants = new SessionGrants(path.join(BRIDGE_HOME, 'dsh-grants.json'));

// dsh is a Node ≥ 24.9 script: the newest installed package, run by such a node (not PATH's).
export function findDsh() {
  const win = process.platform === 'win32';
  const node = pickNode('24.9.0');
  const found = [...(process.env.PATH || '').split(path.delimiter), ...commonDirs()].map((dir) => (win ? dir : path.dirname(dir))).map((prefix) => path.join(prefix, win ? '' : 'lib', 'node_modules/@deepseek-ai/dsh')).flatMap((dir) => {
    try { return [{ bin: path.join(dir, 'lib/bin.js'), version: JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version }]; } catch { return []; }
  }).sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }));
  return node && found[0] ? { ...found[0], node: node.bin } : null;
}

// Approvals reach Baton (the user's profile is not edited), and ask_user_question gets an answerer.
function overlay() {
  const file = path.join(BRIDGE_HOME, 'dsh-baton.patch.yml');
  const plugin = JSON.stringify(fileURLToPath(new URL('./dsh-ask.mjs', import.meta.url)));
  fs.mkdirSync(BRIDGE_HOME, { recursive: true });
  fs.writeFileSync(file, `- id: approval\n  config:\n    policy: ask\n- insert:\n    - id: tool-ask-user\n      name: '@deepseek-ai/dsh-tool-ask-user'\n    - id: baton-ask\n      name: ${plugin}\n`);
  return file;
}

// The model new Sessions get: the user's DSH default (the acp bundle otherwise pins its own).
function defaultModel() {
  for (const profile of ['web', 'acp']) {
    let m;
    try { m = /- id: agent-default-model\s+config:\s+provider:\s*(\S+)\s+model:\s*(\S+)/.exec(fs.readFileSync(path.join(DSH_HOME, 'profiles', profile, 'cordis.patch.yml'), 'utf8')); } catch {}
    if (m) return JSON.stringify([m[1], m[2]]);
  }
  return null;
}

// App image links become ACP image blocks when the model takes images; otherwise, like other
// attachments, they stay as paths in the text.
function promptBlocks(text, vision) {
  const images = [];
  if (!vision) return [{ type: 'text', text }];
  const rest = text.replace(/!\[[^\]]*\]\(([^)\s]+)\)/g, (link, file) => {
    const mimeType = IMAGE_TYPES[path.extname(file).slice(1).toLowerCase()];
    if (!mimeType || !fs.existsSync(file)) return link;
    images.push({ type: 'image', mimeType, data: fs.readFileSync(file).toString('base64') });
    return '';
  }).trim();
  return rest ? [{ type: 'text', text: rest }, ...images] : images;
}

// "Yes, for this session": the tool, and for a command its first word. A command with shell operators
// is never covered, so it always asks.
function sessionRule(t) {
  const command = String(t.input.command || '');
  if (t.name === 'Bash' && /[&;|`<>\n]|\$\(/.test(command)) return null;
  const word = t.name === 'Bash' && command.trim().split(/\s+/)[0];
  return word ? { toolName: 'Bash', ruleContent: `${word}:*` } : { toolName: t.name };
}

const isPrompt = (row) => row.type === 'user' && !String(row.uuid).startsWith('dsh-interrupt')
  && row.content.some((b) => b.type === 'text' || b.type === 'image' || b.type === 'document');

class DshInteraction {
  constructor() {
    this.sessions = new Map(); // native id → { child, rpc, queue, current, callbacks, tags, controls, closing }
    this.flush = async () => {}; // set by the watcher: read a Session's log to its end
    this.onIdle = () => {};
  }

  owns(sid) { return this.sessions.has(sid); }

  // Another process holding the Session's lock must be let go first (writerConflict).
  async heldElsewhere(sid, file = findLog(sid)) {
    if (!file) return null;
    await refreshLocks(SESSIONS);
    const holder = lockHolder(path.join(path.dirname(file), 'session.lock'));
    if (!holder || [...this.sessions.values()].some((s) => s.child?.pid === holder.pid)) return null;
    let cmd = '';
    try { cmd = fs.readFileSync(`/proc/${holder.pid}/cmdline`, 'utf8'); } catch {}
    return { pid: holder.pid, status: sessionIndex.records.get(file)?.state?.open ? 'running' : 'idle', canTerminate: true,
      label: /\0web(\0|$)/.test(cmd) ? 'A dsh web server (closing it ends every session it has open)' : 'Another dsh client' };
  }

  // A process for the Session: initialize, then `open` (session/new or session/resume).
  async spawn(cwd, s, open) {
    const dsh = findDsh();
    if (!dsh) throw new Error('DeepSeek Harness needs dsh and Node.js 24.9 or newer on this computer.');
    Object.assign(s, { key: `dsh:${randomUUID()}`, queue: [], tags: [], controls: new Map(), tools: new Map() });
    s.child = await sessionProcess(s.key, dsh.node, [dsh.bin, '--profile', 'acp', '--patch', overlay()], { cwd, stdio: ['pipe', 'pipe', 'pipe', 'pipe'] });
    s.rpc = new RpcStdio(s.child, {
      onNotify: (method, params) => { if (method === 'session/update' && params.sessionId === s.sid) this.update(s, params.update); },
      onRequest: (method, params) => this.approval(s, method, params),
    });
    this.questions(s);
    try {
      const init = await s.rpc.request('initialize', { protocolVersion: 1, clientCapabilities: {} }, { timeoutMs: 60_000 });
      s.vision = !!init?.agentCapabilities?.promptCapabilities?.image;
      await open();
    } catch (error) {
      if (this.sessions.get(s.sid) === s) this.sessions.delete(s.sid);
      await finishProcess(s.key);
      throw error;
    }
  }

  async create({ cwd, text, streamId, onCreated }) {
    const s = {};
    await this.spawn(cwd, s, async () => {
      const res = await s.rpc.request('session/new', { cwd, mcpServers: [] }, { timeoutMs: 60_000 });
      s.sid = res.sessionId;
      const model = defaultModel();
      if (model && model !== res.configOptions?.find((o) => o.id === 'model')?.currentValue) {
        await s.rpc.request('session/set_config_option', { sessionId: s.sid, configId: 'model', value: model }).catch(() => {});
      }
    });
    this.sessions.set(s.sid, s);
    this.enqueue(s, { turnId: streamId, text, callbacks: await onCreated({ nativeSessionId: s.sid, sessionId: `dsh:${s.sid}` }) });
  }

  // Queued behind a running prompt, or a new process; one that is closing is awaited first.
  async sendExisting({ nativeSessionId: sid, streamId, text, callbacks }) {
    for (;;) {
      let s = this.sessions.get(sid);
      if (!s) {
        const file = findLog(sid);
        const cwd = file && (sessionIndex.records.get(file)?.state?.cwd || catalog.summarize(file).cwd);
        if (!cwd) throw new Error('Session not found on this device.');
        this.sessions.set(sid, s = { sid });
        s.ready = this.spawn(cwd, s, () => s.rpc.request('session/resume', { sessionId: sid, cwd, mcpServers: [] }, { timeoutMs: 60_000 }));
      }
      if (s.closing) { await s.finished; continue; }
      await s.ready;
      if (s.closing) continue;
      return this.enqueue(s, { turnId: streamId, text, callbacks });
    }
  }

  enqueue(s, item) {
    const cb = item.callbacks;
    item.blocks = 0;
    item.framer = new StreamFramer((f) => (f.t === 'start' ? cb.onBlockStart?.(s.sid, f.blockId, f.kind, f.name)
      : f.t === 'stop' ? cb.onBlockStop?.(s.sid, f.blockId) : (f.t === 'delta' ? cb.onDelta : cb.onInputDelta)?.(s.sid, f.chunk, f.blockId)));
    s.queue.push(item);
    s.callbacks = item.callbacks;
    s.finished ||= this.run(s);
  }

  // The turn ends once, after the last queued prompt: an earlier failure shows as its error row.
  async run(s) {
    let last;
    const sent = [];
    while (s.queue.length) {
      const item = s.current = s.queue.shift();
      s.tags.push(item.turnId);
      sent.push(item.turnId);
      item.callbacks.onAccepted?.(item.turnId);
      let result = {};
      try {
        const res = await s.rpc.request('session/prompt', { sessionId: s.sid, prompt: promptBlocks(item.text, s.vision) });
        if (res?.stopReason === 'cancelled') result = { subtype: 'interrupted' };
      } catch (error) {
        console.error(`[dsh] ${s.sid.slice(0, 8)} prompt failed: ${error.message}`);
        result = { is_error: true, subtype: 'error' };
      }
      this.closeBlock(item);
      item.framer.finish();
      s.current = null;
      last = [item, { ...result, consumedInputIds: sent }];
    }
    // Done: release the lock, let the process exit, then end the turn after its last rows.
    s.closing = true;
    await finishProcess(s.key, () => s.rpc.request('session/close', { sessionId: s.sid }, { timeoutMs: 5000 }));
    await this.flush(s.sid).catch(() => {});
    this.sessions.delete(s.sid);
    last[0].callbacks.onResult?.(s.sid, last[1]);
    this.onIdle(s.sid);
  }

  // Rows the watcher read from the log of a Session Baton drives. The first prompt row after a send
  // carries the App's turn id, so the bubble the App drew is that row.
  deliver(sid, rows) {
    const s = this.sessions.get(sid);
    if (!s?.callbacks) return false;
    for (const row of rows) {
      if (s.tags.length && isPrompt(row)) row.nativeId = `live:user:${s.tags.shift()}`;
      s.callbacks.onMessage?.(s.sid, row, { normalized: true });
    }
    return true;
  }

  // session/resume replays the history as updates; only those during Baton's prompt are new.
  update(s, u) {
    const item = s.current;
    if (!item) return;
    if (u.sessionUpdate === 'agent_message_chunk' || u.sessionUpdate === 'agent_thought_chunk') {
      const key = `${u.messageId}:${u.sessionUpdate}`;
      const kind = u.sessionUpdate === 'agent_message_chunk' ? 'text' : 'thinking';
      if (item.open !== key) { this.closeBlock(item); item.open = key; item.framer.start(++item.blocks, kind); }
      item.framer.delta(item.blocks, u.content?.text || '');
    } else if (u.sessionUpdate === 'tool_call') {
      this.closeBlock(item);
      const t = mapTool(u.title, u.rawInput || {});
      s.tools.set(u.toolCallId, t);
      item.framer.start(++item.blocks, 'tool_use', t.name);
      item.framer.input(item.blocks, JSON.stringify(t.input));
      item.framer.stop(item.blocks);
    }
  }

  closeBlock(item) {
    if (item.open) item.framer.stop(item.blocks);
    item.open = null;
  }

  // A prompt to the App; `respond(reply)` answers dsh.
  control(s, requestId, request, respond) {
    s.controls.set(requestId, respond);
    s.callbacks?.onControlRequest?.({ request_id: requestId, request });
  }

  replyControl(sid, requestId, reply) {
    const controls = this.sessions.get(sid)?.controls;
    const respond = controls?.get(requestId);
    return !!respond && (controls.delete(requestId), respond(reply), true);
  }

  // ACP session/request_permission: allow once or reject once (dsh has no lasting grant).
  approval(s, method, params) {
    if (method !== 'session/request_permission') throw Object.assign(new Error(`${method} not supported`), { code: -32601 });
    const callId = params.toolCall?.toolCallId;
    const t = s.tools.get(callId) || mapTool(params.toolCall?.title, params.toolCall?.rawInput || {});
    const rule = sessionRule(t);
    const grant = rule && (rule.ruleContent ? `${rule.toolName}(${rule.ruleContent})` : rule.toolName);
    const option = (allow) => ({ outcome: { outcome: 'selected', optionId: (params.options || [])
      .find((o) => String(o.kind || o.optionId).startsWith(allow ? 'allow' : 'reject'))?.optionId || (allow ? 'allow-once' : 'reject-once') } });
    if (grant && grants.get(`dsh:${s.sid}`).includes(grant)) return option(true);
    return new Promise((resolve) => this.control(s, `dsh:${callId}`, {
      tool_name: t.name, input: t.input, ...(rule ? { permission_suggestions: [{ type: 'addRules', behavior: 'allow', rules: [rule] }] } : {}),
    }, (reply) => {
      if (grant && reply.decision === 'allow' && reply.scope === 'session') grants.add(`dsh:${s.sid}`, [grant]);
      resolve(option(reply.decision === 'allow'));
    }));
  }

  // baton-ask on fd 3: ask_user_question → an ask prompt whose answers keep each question's id.
  questions(s) {
    const pipe = s.child.stdio[3];
    let buf = '';
    pipe.setEncoding('utf8');
    pipe.on('error', () => {});
    pipe.on('data', (text) => {
      buf += text;
      for (let i = buf.indexOf('\n'); i !== -1; i = buf.indexOf('\n')) {
        let m;
        try { m = JSON.parse(buf.slice(0, i)); } catch {}
        buf = buf.slice(i + 1);
        const requestId = `dsh:q:${m?.id}`;
        if (m?.cancelled) s.controls.delete(requestId) && s.callbacks?.onControlResolved?.(requestId);
        else if (m?.questions) {
          this.control(s, requestId, { tool_name: 'AskUserQuestion', input: { questions: m.questions }, requires_user_interaction: true }, (reply) => {
            const answers = reply.decision === 'answer' && m.questions.map((q) => {
              const labels = [].concat(reply.answers?.[q.id] ?? reply.answers?.[q.question] ?? []).map(String);
              const selected = labels.filter((l) => (q.options || []).some((o) => o.label === l));
              const custom = labels.filter((l) => !selected.includes(l)).join(', ');
              return { id: q.id, selected, ...(custom ? { custom } : {}) };
            });
            pipe.write(`${JSON.stringify(answers ? { id: m.id, answers } : { id: m.id, cancelled: true })}\n`);
          });
        }
      }
    });
  }

  interrupt(sid) {
    if (this.sessions.get(sid)?.current) this.sessions.get(sid).rpc.notify('session/cancel', { sessionId: sid });
  }

  // Skills run as /name in the prompt; ACP offers no command catalog.
  async listCommands({ cwd }) {
    return { commands: listSkills(cwd).map((skill) => ({ ...skill, source: 'runtime', argumentHint: '', aliases: [], behavior: 'compose' })), skills: [] };
  }

  forgetGrants(sid) { grants.forget(`dsh:${sid}`); }

  async shutdown() {
    await Promise.all([...this.sessions.values()].map((s) => s.key && finishProcess(s.key, () => s.rpc.request('session/close', { sessionId: s.sid }, { timeoutMs: 2000 }))));
  }
}

export const findLog = (sid) => readdir(SESSIONS).map((p) => path.join(SESSIONS, p, sid, LOG)).find((file) => fs.existsSync(file)) || null;

// Skills DSH offers as /name (dsh-skill-filesystem's roots, first wins): <name>/SKILL.md or <name>.md
// with a kebab-case `name` and a `description` in the front matter.
function listSkills(cwd) {
  let root = path.resolve(cwd);
  while (!fs.existsSync(path.join(root, '.git')) && path.dirname(root) !== root) root = path.dirname(root);
  if (!fs.existsSync(path.join(root, '.git'))) root = path.resolve(cwd);
  const found = new Map();
  for (const dir of [path.join(root, '.dsh/skills'), path.join(root, '.agents/skills'), path.join(DSH_HOME, 'skills'), path.join(os.homedir(), '.agents/skills')]) {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.name !== '.system'); } catch {}
    for (const e of entries) {
      let head = '';
      try { head = /^---\r?\n([\s\S]*?)\r?\n---/.exec(fs.readFileSync(path.join(dir, e.name, e.isFile() ? '' : 'SKILL.md'), 'utf8'))?.[1] || ''; } catch {}
      const field = (k) => new RegExp(`^${k}:\\s*(['"]?)(.*)\\1\\s*$`, 'm').exec(head)?.[2] || '';
      const name = field('name');
      if (/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) && field('description') && field('user-invocable') !== 'false' && !found.has(name)) found.set(name, { name, description: field('description') });
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

DshInteraction.prototype.isBusy = DshInteraction.prototype.owns;
export const dshInteraction = defineInteractionAdapter(Object.assign(new DshInteraction(), { runtime: 'dsh' }));
