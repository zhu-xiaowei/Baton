// Interaction through the user's own OpenCode background service (service.json, Basic auth). Baton
// starts it only to send: `service start` resumes suspended sessions, so reading never starts it.
// One /api/event SSE while Baton drives a turn, closed 120 s after the last one ends.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { defineInteractionAdapter } from '../../interaction-adapter.mjs';
import { findRuntimeBin } from '../../runtime-bin.mjs';
import { StreamFramer } from '../../stream-framer.mjs';
import { SERVICE_FILE, messageRows, toolName } from './extract.mjs';
import { db } from './history.mjs';

const IDLE_MS = 120_000;
const ASK_RULES = [{ action: 'shell', resource: '*', effect: 'ask' }, { action: 'edit', resource: '*', effect: 'ask' }];
const BOOL = [{ label: 'Yes', value: true }, { label: 'No', value: false }];
const loc = (dir) => `location[directory]=${encodeURIComponent(dir)}`;
const run = (bin, args) => new Promise((resolve, reject) => execFile(bin, args, { timeout: 60_000 },
  (error, stdout, stderr) => (error ? reject(new Error(String(stderr || error.message).trim())) : resolve(stdout))));

// Live opencode processes (service, TUI, run, acp) as { pid, args }.
export function opencodeProcesses() {
  if (process.platform === 'win32') return [];
  try {
    return execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8', timeout: 5000 }).split('\n')
      .map((line) => /^\s*(\d+)\s+(\S+)\s*(.*)$/.exec(line)).filter((m) => m && /(^|\/)opencode(\.exe)?$/.test(m[2]))
      .map((m) => ({ pid: Number(m[1]), args: m[3] }));
  } catch { return []; }
}

let bin;
const opencodeBin = () => (bin ??= findRuntimeBin('opencode', [path.join(os.homedir(), '.opencode/bin')], '2.2.0')?.bin || null);

function serviceInfo() {
  try {
    const { url, password } = JSON.parse(fs.readFileSync(SERVICE_FILE, 'utf8'));
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname)) return null;
    return { url: url.replace(/\/$/, ''), auth: 'Basic ' + Buffer.from(`opencode:${password}`).toString('base64') };
  } catch { return null; }
}

async function request(method, p, body) {
  const svc = serviceInfo();
  if (!svc) throw Object.assign(new Error('OpenCode service is not running'), { down: true });
  let res;
  try {
    res = await fetch(svc.url + p, { method, headers: { Authorization: svc.auth, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30_000) });
  } catch (error) { throw Object.assign(error, { down: true }); }
  const text = await res.text();
  if (!res.ok) throw new Error(`OpenCode ${method} ${p}: ${res.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

export const service = {
  // Without the service (rename, delete) a private, unregistered server runs the call: it never resumes sessions.
  async api(method, p, body) {
    try { return await request(method, p, body); } catch (error) {
      if (!error.down || !opencodeBin()) throw error;
      return run(opencodeBin(), ['api', method, p, ...(body ? ['-d', JSON.stringify(body)] : []), '--standalone']);
    }
  },
  async ensure() {
    try { return await request('GET', '/api/info'); } catch (error) {
      if (!error.down) throw error;
      if (!opencodeBin()) throw new Error('OpenCode 2.2 or later was not found on this computer.');
      await run(opencodeBin(), ['service', 'start']);
      return request('GET', '/api/info');
    }
  },
};

const execs = new Map(); // native session id → the Baton execution in flight
const asked = new Map(); // requestId → permission or form, for the reply
const pending = new Map(); // native session id → Set of open request ids
let sse = null;
let idleTimer = null;

function connect() {
  clearTimeout(idleTimer);
  if (sse) return sse.ready;
  const svc = serviceInfo();
  const ctrl = new AbortController();
  let ready;
  const current = sse = { ctrl, ready: new Promise((resolve) => { ready = resolve; }) };
  (async () => {
    const res = await fetch(`${svc.url}/api/event`, { headers: { Authorization: svc.auth, Accept: 'text/event-stream' }, signal: ctrl.signal });
    const decoder = new TextDecoder();
    let buf = '';
    for await (const chunk of res.body) {
      buf += decoder.decode(chunk, { stream: true });
      for (let i; (i = buf.indexOf('\n\n')) >= 0; buf = buf.slice(i + 2)) {
        const data = buf.slice(0, i).split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n');
        let ev;
        try { ev = JSON.parse(data); } catch { continue; }
        if (ev.type === 'server.connected') ready();
        else dispatch(ev);
      }
    }
  })().catch((error) => { if (error.name !== 'AbortError') console.error(`[opencode] events: ${error.message}`); }).finally(() => {
    ready();
    if (sse !== current) return;
    sse = null;
    pending.clear(); // no longer known
    for (const [id, exec] of execs) end(id, exec, { is_error: true, subtype: 'unavailable' }); // the service went away
  });
  return current.ready;
}

function end(id, exec, result) {
  exec.framer.finish();
  execs.delete(id);
  exec.callbacks.onResult(`opencode:${id}`, { ...result, consumedInputIds: [...exec.turns] });
  interaction.settled?.();
  if (!execs.size) idleTimer = setTimeout(() => { sse?.ctrl.abort(); sse = null; }, IDLE_MS).unref();
}

function newExec(callbacks) {
  const exec = { callbacks, blocks: new Map(), steps: new Map(), inbox: new Map(), texts: new Map(), turns: new Set() };
  exec.framer = new StreamFramer((f) => {
    if (f.t === 'start') callbacks.onBlockStart('', f.blockId, f.kind, f.name);
    else if (f.t === 'delta') callbacks.onDelta('', f.chunk, f.blockId);
    else if (f.t === 'input') callbacks.onInputDelta('', f.chunk, f.blockId);
    else callbacks.onBlockStop('', f.blockId);
  });
  return exec;
}

function track(sid, requestId, open) {
  const set = pending.get(sid) || pending.set(sid, new Set()).get(sid);
  if (open) set.add(requestId); else set.delete(requestId);
}

// A permission or form as the control_request queuePermissionRequest takes.
function controlRequest(p, form) {
  asked.set(p.id, p);
  track(p.sessionID, p.id, true);
  const name = toolName(p.action);
  return { request_id: p.id, request: form ? { tool_name: 'AskUserQuestion', requires_user_interaction: true,
    input: { questions: (p.fields || []).map((f) => ({ id: f.key, header: f.title || '', question: f.description || f.title || '',
      multiSelect: f.type === 'multiselect', options: (f.options || (f.type === 'boolean' ? BOOL : [])).map((o) => ({ label: o.label, description: o.description || '' })) })) } }
    : { tool_name: name, input: p.action === 'shell' ? { command: (p.resources || []).join('\n') } : { file_path: (p.resources || []).join(', ') },
      permission_suggestions: p.save?.length ? [{ type: 'addRules', behavior: 'allow', rules: p.save.map((r) => ({ toolName: name, ruleContent: r })) }] : [] } };
}

// Service events of a Baton execution → the shared stream outlet.
function dispatch(ev) {
  const d = ev.data || {};
  const sid = d.sessionID || d.form?.sessionID;
  const control = ev.type === 'permission.asked' ? controlRequest(d) : ev.type === 'form.created' ? controlRequest(d.form, true) : null;
  if (/^(permission\.replied|form\.(replied|cancelled))$/.test(ev.type)) track(sid, d.requestID || d.id || d.form?.id, false);
  const exec = execs.get(sid);
  if (!exec) return;
  const cb = exec.callbacks;
  const block = (key) => exec.blocks.get(key) ?? exec.blocks.set(key, exec.blocks.size + 1).get(key);
  const step = exec.steps.get(d.assistantMessageID) || exec.steps.set(d.assistantMessageID, []).get(d.assistantMessageID);
  const authority = (rows) => { for (const row of rows) cb.onMessage('', row, { normalized: true, runtime: 'opencode', liveKey: row.uuid }); };
  const assistant = (finish) => authority(messageRows({ id: d.assistantMessageID, type: 'assistant', data: { content: step, finish, time: { created: ev.created } } }));
  const kind = ev.type.split('.')[1];
  const key = `${d.assistantMessageID}:${kind}${d.ordinal ?? d.id}`;
  switch (ev.type) {
    case 'session.execution.started': return cb.onAccepted?.();
    case 'session.inbox.enqueued': exec.inbox.set(d.inboxID, d.item); return;
    case 'session.inbox.delivered': {
      const item = exec.inbox.get(d.inboxID);
      exec.framer.finish();
      if (item?.type === 'user') authority(messageRows({ id: d.inboxID, type: 'user', data: { ...item.payload, time: { created: ev.created } } }));
      return;
    }
    case 'session.text.started': case 'session.reasoning.started':
      return exec.framer.start(block(key), kind === 'text' ? 'text' : 'thinking');
    case 'session.text.delta': case 'session.reasoning.delta':
      exec.texts.set(key, (exec.texts.get(key) || '') + d.delta);
      return exec.framer.delta(block(key), d.delta);
    case 'session.text.ended': case 'session.reasoning.ended': {
      // Some providers send no deltas; the ended text completes the preview.
      const seen = exec.texts.get(key) || '';
      if (d.text?.startsWith(seen) && d.text.length > seen.length) exec.framer.delta(block(key), d.text.slice(seen.length));
      exec.framer.stop(block(key));
      step.push({ type: kind, text: d.text || '' });
      return;
    }
    case 'session.tool.input.started':
      exec.framer.start(block(key), 'tool_use', toolName(d.name));
      step.push({ type: 'tool', id: d.id, name: d.name, state: { status: 'pending' } });
      return;
    case 'session.tool.input.delta': return exec.framer.input(block(key), d.delta);
    case 'session.tool.input.ended': return exec.framer.stop(block(key));
    case 'session.tool.called': case 'session.tool.success': case 'session.tool.failed': {
      const tool = step.find((part) => part.id === d.id);
      if (!tool) return;
      const input = d.input || tool.state.input;
      tool.state = ev.type === 'session.tool.called' ? { status: 'running', input }
        : ev.type === 'session.tool.success' ? { status: 'completed', input, content: d.content, metadata: d.metadata }
          : { status: 'error', input, error: d.error, content: d.content };
      return assistant();
    }
    case 'session.step.ended': case 'session.step.failed': return assistant(d.finish);
    case 'permission.asked': case 'form.created': return cb.onControlRequest(control);
    case 'permission.replied': case 'form.replied': case 'form.cancelled':
      return cb.onControlResolved(d.requestID || d.id || d.form?.id);
    case 'session.execution.succeeded': case 'session.execution.failed': case 'session.execution.interrupted':
      return end(sid, exec, { is_error: ev.type === 'session.execution.failed', subtype: ev.type.split('.')[2] });
    default:
  }
}

// Baton's upload references become prompt files (OpenCode inlines them); the text keeps them too.
function promptFiles(text) {
  const files = [];
  for (const m of text.matchAll(/!\[[^\]]*\]\(([^)\s]*[\\/]\.baton-bridge[\\/]tmp[\\/][^)\s]+)\)|\[([^\]\r\n]*)\]\(<([^<>\r\n]*[\\/]\.baton-bridge[\\/]attachments[\\/][^<>\r\n]+)>\)/g)) {
    const file = m[1] || m[3];
    if (fs.existsSync(file)) files.push({ uri: pathToFileURL(file).href, name: m[1] ? path.basename(file) : m[2] });
  }
  return files;
}

async function prompt(id, text, turnId) {
  const command = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (command && ((await request('GET', `/api/command?${loc(sessionOf(id)?.directory || '')}`))?.data || []).some((c) => c.name === command[1])) {
    return request('POST', `/api/session/${id}/command`, { name: command[1], text: command[2] || '' });
  }
  const files = promptFiles(text);
  // No `delivery`: while a turn runs, OpenCode steers the prompt into it at the next step.
  return request('POST', `/api/session/${id}/prompt`, { text, metadata: { baton: { turnId } }, ...(files.length ? { files } : {}) });
}

async function start(id, callbacks, text, turnId) {
  let exec = execs.get(id);
  if (exec?.callbacks !== callbacks) execs.set(id, exec = newExec(callbacks));
  exec.turns.add(turnId);
  try { await prompt(id, text, turnId); } catch (error) {
    exec.turns.delete(turnId);
    if (!exec.turns.size) execs.delete(id);
    throw error;
  }
}

const sessionOf = (id) => db.all('SELECT directory, time_busy, time_idle FROM session_v2 WHERE id = ?', [id])[0];
const dbBusy = (id) => sessionOf(id)?.time_busy > (sessionOf(id)?.time_idle || 0);
const cwdOf = (pid) => { try { return fs.readlinkSync(`/proc/${pid}/cwd`); } catch { return ''; } };

export const interaction = defineInteractionAdapter({
  runtime: 'opencode',
  pending: (id) => (pending.get(id)?.size || 0) > 0,
  async create({ cwd, text, streamId, onCreated }) {
    await service.ensure();
    await connect();
    // No title: OpenCode then names the session itself.
    const { data } = await request('POST', '/api/session', { location: { directory: cwd }, permissions: ASK_RULES });
    await start(data.id, await onCreated({ nativeSessionId: data.id, sessionId: `opencode:${data.id}` }), text, streamId);
  },
  async sendExisting({ nativeSessionId, streamId, text, callbacks }) {
    await service.ensure();
    await connect();
    await start(nativeSessionId, callbacks, text, streamId);
  },
  async interrupt(id) {
    await request('POST', `/api/session/${id}/interrupt`, {});
    for (const child of db.all('SELECT id FROM session_v2 WHERE parent_id = ? AND time_busy > coalesce(time_idle, 0)', [id])) {
      await request('POST', `/api/session/${child.id}/interrupt`, {}).catch(() => {});
    }
  },
  // Session scope adds the request's save patterns to this session's own rules (they survive restarts);
  // a deny must carry a message, or OpenCode cancels the whole turn.
  replyControl(id, requestId, { decision, answers = {}, scope }) {
    const req = asked.get(requestId);
    asked.delete(requestId);
    track(id, requestId, false);
    const base = `/api/session/${id}`;
    const reply = async () => {
      if (req?.fields) {
        if (decision !== 'answer') return request('DELETE', `${base}/form/${requestId}`);
        const answer = {};
        for (const f of req.fields) {
          const values = (answers[f.key] || []).map((label) => (f.options || (f.type === 'boolean' ? BOOL : [])).find((o) => o.label === label)?.value ?? label);
          if (values.length) answer[f.key] = f.type === 'multiselect' ? values : /^(number|integer)$/.test(f.type) ? Number(values[0]) : values[0];
        }
        return request('POST', `${base}/form/${requestId}/reply`, { answer });
      }
      if (decision === 'allow' && scope === 'session' && req?.save?.length) {
        const rules = (await request('GET', base))?.data?.permissions || [];
        await request('PATCH', base, { permissions: [...rules, ...req.save.map((resource) => ({ action: req.action, resource, effect: 'allow' }))] });
      }
      return request('POST', `${base}/permission/${requestId}/reply`, decision === 'allow' ? { decision: 'once' }
        : { decision: 'reject', message: 'The user declined this action.' });
    };
    reply().catch((error) => console.error(`[opencode] reply failed: ${error.message}`));
    return true;
  },
  owns: (id) => execs.has(id),
  isBusy: (id) => execs.has(id) || (dbBusy(id) && opencodeProcesses().length > 0),
  // Busy in the database but not in the service: a standalone TUI / run / acp process writes it.
  async heldElsewhere(id) {
    if (execs.has(id) || !dbBusy(id)) return null;
    const active = await request('GET', '/api/session/active').then((r) => r?.data || {}, () => ({}));
    if (active[id]) return null;
    const writer = opencodeProcesses().find((p) => !/\bserve\b|\bservice\b/.test(p.args) && (p.args.includes(id) || cwdOf(p.pid) === sessionOf(id).directory));
    return writer ? { pid: writer.pid, status: 'running', label: 'An OpenCode terminal', canTerminate: true } : null;
  },
  // A request waiting since before this Bridge (or outside a Baton turn) is shown on subscribe.
  async observePermissions({ nativeSessionId: id, callbacks }) {
    if (execs.has(id) || !serviceInfo()) return;
    for (const kind of ['permission', 'form']) {
      for (const p of await request('GET', `/api/session/${id}/${kind}`).then((r) => r?.data || [], () => [])) {
        callbacks.onControlRequest(controlRequest(p, kind === 'form'));
      }
    }
  },
  async listCommands({ cwd }) {
    if (!serviceInfo()) return { commands: [], skills: [] };
    const list = await request('GET', `/api/command?${loc(cwd)}`).then((r) => r?.data || [], () => []);
    return { commands: list.map((c) => ({ name: c.name, description: c.description || '', source: 'runtime' })), skills: [] };
  },
  shutdown() { sse?.ctrl.abort(); sse = null; },
});
