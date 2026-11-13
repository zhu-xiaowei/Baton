// Interaction through the user's own OpenCode service. Only a send starts it (`service start` resumes
// suspended sessions). One /api/event SSE while Baton drives a turn, closed 120 s after the last.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { defineInteractionAdapter } from './interaction-adapter.mjs';
import { findRuntimeBin } from './runtime-bin.mjs';
import { StreamFramer } from './stream-framer.mjs';
import { SERVICE_FILE, messageRows, toolName } from './opencode-extract.mjs';
import { db } from './opencode-history.mjs';

const IDLE_MS = 120_000;
const ASK_RULES = [{ action: 'shell', resource: '*', effect: 'ask' }, { action: 'edit', resource: '*', effect: 'ask' }];
const BOOL = [{ label: 'Yes', value: true }, { label: 'No', value: false }];
const loc = (dir) => `location[directory]=${encodeURIComponent(dir)}`;
const run = (bin, args) => new Promise((resolve, reject) => execFile(bin, args, { timeout: 60_000 },
  (error, stdout, stderr) => (error ? reject(new Error(String(stderr || error.message).trim())) : resolve(stdout))));

// opencode processes other than a service (TUI, run, acp).
export function writerProcesses() {
  if (process.platform === 'win32') return [];
  try {
    return execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8', timeout: 5000 }).split('\n')
      .map((line) => /^\s*(\d+)\s+(\S+)\s*(.*)$/.exec(line)).filter((m) => m && /(^|\/)opencode(\.exe)?$/.test(m[2]) && !/\bserve\b|\bservice\b/.test(m[3]))
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
  const res = await fetch(svc.url + p, { method, headers: { Authorization: svc.auth, 'content-type': 'application/json' },
    body: body && JSON.stringify(body), signal: AbortSignal.timeout(30_000) }).catch((error) => { throw Object.assign(error, { down: true }); });
  const text = await res.text();
  if (!res.ok) throw new Error(`OpenCode ${method} ${p}: ${res.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

export const service = {
  // Without the service, a private unregistered server runs it (it resumes nothing).
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

const execs = new Map(); // session id → Baton's execution
const asked = new Map(); // request id → permission or form
const pending = new Map(); // open request id → session id
const shown = new Map(); // request id → onControlResolved of the subscribe that showed it
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
    pending.clear(); // no longer known
    if (sse !== current) return;
    sse = null;
    for (const [id, exec] of execs) end(id, exec, { is_error: true, subtype: 'unavailable' });
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

// A request is gone: the page that subscribed to it is told, like a reply event would.
function settle(requestId, notify = true) {
  pending.delete(requestId);
  if (notify) shown.get(requestId)?.(requestId);
  shown.delete(requestId);
}

function newExec(callbacks) {
  const exec = { callbacks, blocks: new Map(), steps: new Map(), inbox: new Map(), texts: new Map(), turns: new Set(), commands: [], open: null };
  exec.framer = new StreamFramer((f) => {
    if (f.t === 'start') callbacks.onBlockStart('', f.blockId, f.kind, f.name);
    else if (f.t === 'delta') callbacks.onDelta('', f.chunk, f.blockId);
    else if (f.t === 'input') callbacks.onInputDelta('', f.chunk, f.blockId);
    else callbacks.onBlockStop('', f.blockId);
  });
  return exec;
}

function controlRequest(p, form) {
  asked.set(p.id, p);
  pending.set(p.id, p.sessionID);
  const name = toolName(p.action);
  return { request_id: p.id, request: form ? { tool_name: 'AskUserQuestion', requires_user_interaction: true,
    input: { questions: (p.fields || []).map((f) => ({ id: f.key, header: f.title || '', question: f.description || f.title || '',
      multiSelect: f.type === 'multiselect', options: (f.options || (f.type === 'boolean' ? BOOL : [])).map((o) => ({ label: o.label, description: o.description || '' })) })) } }
    : { tool_name: name, input: p.action === 'shell' ? { command: (p.resources || []).join('\n') } : { file_path: (p.resources || []).join(', ') },
      permission_suggestions: p.save?.length ? [{ type: 'addRules', behavior: 'allow', rules: p.save.map((r) => ({ toolName: name, ruleContent: r })) }] : [] } };
}

function dispatch(ev) {
  const d = ev.data || {};
  const sid = d.sessionID || d.form?.sessionID;
  const control = ev.type === 'permission.asked' ? controlRequest(d) : ev.type === 'form.created' ? controlRequest(d.form, true) : null;
  const replied = /^(permission\.replied|form\.(replied|cancelled))$/.test(ev.type);
  if (replied) settle(d.requestID || d.id || d.form?.id);
  // A subagent's request belongs to the Baton turn of its root.
  let exec = execs.get(sid);
  for (let id = sid; !exec && (control || replied) && (id = sessionOf(id)?.parent_id);) exec = execs.get(id);
  if (!exec) return;
  const cb = exec.callbacks;
  const block = (key) => exec.blocks.get(key) ?? exec.blocks.set(key, exec.blocks.size + 1).get(key);
  const step = exec.steps.get(d.assistantMessageID) || exec.steps.set(d.assistantMessageID, []).get(d.assistantMessageID);
  const authority = (rows) => { for (const row of rows) cb.onMessage('', row, { normalized: true, runtime: 'opencode', liveKey: row.uuid }); };
  const assistant = (finish) => authority(messageRows({ id: d.assistantMessageID, type: 'assistant', data: { content: step, finish, time: { created: ev.created } } }));
  const kind = ev.type.split('.')[1];
  const key = `${d.assistantMessageID}:${kind}${d.ordinal ?? d.id}`;
  // One block at a time: OpenCode starts the text before it ends a streamed reasoning.
  const close = () => { if (exec.open != null) exec.framer.stop(exec.open); exec.open = null; };
  const live = exec.open === block(key);
  switch (ev.type) {
    case 'session.execution.started': return cb.onAccepted?.();
    case 'session.inbox.enqueued': // a command's prompt has no metadata of its own
      if (d.item.type === 'user' && !d.item.payload?.metadata && exec.commands.length) d.item.payload.metadata = { baton: { turnId: exec.commands.shift() } };
      exec.inbox.set(d.inboxID, d.item);
      return;
    case 'session.inbox.delivered': {
      const item = exec.inbox.get(d.inboxID);
      exec.framer.finish();
      if (item?.type === 'user') authority(messageRows({ id: d.inboxID, type: 'user', data: { ...item.payload, time: { created: ev.created } } }));
      return;
    }
    case 'session.text.started': case 'session.reasoning.started': case 'session.tool.input.started':
      close();
      exec.framer.start(exec.open = block(key), kind === 'tool' ? 'tool_use' : kind === 'text' ? 'text' : 'thinking', d.name && toolName(d.name));
      if (d.name) step.push({ type: 'tool', id: d.id, name: d.name, state: { status: 'pending' } });
      return;
    case 'session.text.delta': case 'session.reasoning.delta':
      exec.texts.set(key, (exec.texts.get(key) || '') + d.delta);
      return live && exec.framer.delta(exec.open, d.delta);
    case 'session.tool.input.delta': return live && exec.framer.input(exec.open, d.delta);
    case 'session.text.ended': case 'session.reasoning.ended': {
      // Some providers send no deltas; the ended text completes the preview.
      const seen = exec.texts.get(key) || '';
      if (live && d.text?.startsWith(seen) && d.text.length > seen.length) exec.framer.delta(exec.open, d.text.slice(seen.length));
      step.push({ type: kind, text: d.text || '' });
    } // falls through
    case 'session.tool.input.ended': return live && close();
    case 'session.tool.called': case 'session.tool.success': case 'session.tool.failed': {
      const tool = step.find((part) => part.id === d.id);
      if (!tool) return;
      const input = d.input || tool.state.input;
      tool.state = { status: { called: 'running', success: 'completed' }[ev.type.split('.')[2]] || 'error', input, content: d.content, metadata: d.metadata, error: d.error };
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

// A `/name` the service knows runs as its command (an unknown one answers 404 and is sent as text).
async function prompt(id, text, turnId, exec) {
  const command = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (command) {
    exec.commands.push(turnId);
    if (await request('POST', `/api/session/${id}/command`, { name: command[1], text: command[2] || '' })
      .then(() => true, (error) => { if (!/ 404 /.test(error.message)) throw error; })) return;
    exec.commands.splice(exec.commands.indexOf(turnId), 1);
  }
  const files = promptFiles(text);
  // No `delivery`: while a turn runs, OpenCode steers the prompt into it at the next step.
  return request('POST', `/api/session/${id}/prompt`, { text, metadata: { baton: { turnId } }, ...(files.length ? { files } : {}) });
}

async function start(id, callbacks, text, turnId) {
  let exec = execs.get(id);
  if (exec?.callbacks !== callbacks) execs.set(id, exec = newExec(callbacks));
  exec.turns.add(turnId);
  try { await prompt(id, text, turnId, exec); } catch (error) {
    exec.turns.delete(turnId);
    if (!exec.turns.size) execs.delete(id);
    throw error;
  }
}

let active = new Set(); // sessions the service runs
export const refreshActive = () => request('GET', '/api/session/active').then((r) => { active = new Set(Object.keys(r?.data || {})); }, () => { active = new Set(); });
const cwdOf = (pid) => { try { return fs.readlinkSync(`/proc/${pid}/cwd`); } catch { return ''; } };
const writerOf = (id, directory, procs = writerProcesses()) => procs.find((p) => p.args.includes(id) || cwdOf(p.pid) === directory);
// Someone runs a busy session: Baton, the service, or another process on it (else it is an orphaned claim).
export const working = (id, directory, procs) => execs.has(id) || active.has(id) || !!writerOf(id, directory, procs);
const sessionOf = (id) => db.all('SELECT directory, parent_id, time_busy, time_idle FROM session_v2 WHERE id = ?', [id])[0];
const busyChildren = (id) => db.all('SELECT id FROM session_v2 WHERE parent_id = ? AND time_busy > coalesce(time_idle, 0)', [id]).map((r) => r.id);
const dbBusy = (id) => sessionOf(id)?.time_busy > (sessionOf(id)?.time_idle || 0);

export const interaction = defineInteractionAdapter({
  runtime: 'opencode',
  pending: (id) => [...pending.values()].includes(id),
  pendingSessions: () => new Set(pending.values()),
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
    for (const child of busyChildren(id)) await request('POST', `/api/session/${child}/interrupt`, {}).catch(() => {});
  },
  // Session scope adds the request's save patterns to this session's own rules (they survive restarts);
  // a deny must carry a message, or OpenCode cancels the whole turn.
  replyControl(id, requestId, { decision, answers = {}, scope }) {
    const req = asked.get(requestId);
    asked.delete(requestId);
    settle(requestId, false);
    const base = `/api/session/${req?.sessionID || id}`; // a subagent's own session
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
  isBusy: (id) => execs.has(id) || active.has(id),
  // Busy but not run by the service: a standalone TUI / run / acp writes it.
  async heldElsewhere(id) {
    if (execs.has(id) || !dbBusy(id)) return null;
    await refreshActive();
    const writer = !active.has(id) && writerOf(id, sessionOf(id).directory);
    return writer ? { pid: writer.pid, status: 'running', label: 'An OpenCode terminal', canTerminate: true } : null;
  },
  // Requests waiting outside a Baton turn (its subagents' too) show on subscribe.
  async observePermissions({ nativeSessionId: id, callbacks }) {
    if (execs.has(id) || !serviceInfo()) return;
    for (const sid of [id, ...busyChildren(id)]) {
      const [perms, forms] = await interaction.reconcile(sid);
      for (const [p, form] of [...perms.map((p) => [p]), ...forms.map((f) => [f, true])]) {
        shown.set(p.id, callbacks.onControlResolved);
        callbacks.onControlRequest(controlRequest(p, form));
      }
    }
  },
  // The service's open requests of a session; ones answered elsewhere leave `pending`.
  async reconcile(id) {
    const lists = await Promise.all(['permission', 'form'].map((kind) => request('GET', `/api/session/${id}/${kind}`).then((r) => r?.data || [], () => [])));
    const open = new Set(lists.flat().map((p) => p.id));
    for (const [rid, sid] of pending) if (sid === id && !open.has(rid)) settle(rid);
    return lists;
  },
  async listCommands({ cwd }) {
    if (!serviceInfo()) return { commands: [], skills: [] };
    const get = () => request('GET', `/api/command?${loc(cwd)}`).then((r) => r?.data || [], () => []);
    let list = await get();
    // A directory the service has not opened yet lists nothing on the first request.
    if (!list.length) list = await new Promise((r) => setTimeout(r, 700)).then(get);
    return { commands: list.map((c) => ({ name: c.name, description: c.description || '', source: 'runtime' })), skills: [] };
  },
  shutdown() { sse?.ctrl.abort(); sse = null; },
});
