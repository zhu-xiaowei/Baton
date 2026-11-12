// Pi interaction over `pi --mode rpc`: one process per Session, started on send and ended once Pi
// reports agent_settled (design §6.6). A send during a turn is steered into it.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RpcStdio } from './rpc-stdio.mjs';
import { finishProcess, sessionProcess } from './turn-process.mjs';
import { SessionGrants } from './session-grants.mjs';
import { StreamFramer } from './stream-framer.mjs';
import { defineInteractionAdapter } from './interaction-adapter.mjs';
import { BRIDGE_HOME } from './config.mjs';
import { piRows, piTools, withImages } from './pi-catalog.mjs';

const APPROVAL_EXT = fileURLToPath(new URL('./pi-approval-ext.mjs', import.meta.url));
const INTERRUPT = '[Request interrupted by user]';
const DIALOGS = new Set(['select', 'confirm', 'input', 'editor']);
const IMAGE = /!\[[^\]]*\]\(([^)]+\.(png|jpe?g|gif|webp))\)/gi;
export const piGrants = new SessionGrants(path.join(BRIDGE_HOME, 'pi-grants.json'));
const live = new Map(); // nativeId → the Session's process
const ownPids = new Set();

// Attached images go in the prompt's images field; Pi does not read local image paths itself.
function prompt(turnId, text) {
  const images = [];
  const message = text.replace(IMAGE, (all, file, ext) => {
    try { images.push({ type: 'image', mimeType: `image/${ext.toLowerCase().replace('jpg', 'jpeg')}`, data: fs.readFileSync(file, 'base64') }); return ''; } catch { return all; }
  });
  return { message: `<!--baton:${turnId}-->${message.trim()}`, ...(images.length ? { images } : {}) };
}

const existing = (dir) => (dir && fs.existsSync(dir) ? dir : undefined);

function request(s, cmd) {
  const id = `b${++s.n}`;
  return new Promise((resolve) => { s.waiting.set(id, resolve); s.rpc.write({ id, ...cmd }); });
}

// Frames and authority rows go out in Pi's order, also when a row waits for its image upload.
const later = (s, fn) => { s.queue = s.queue.then(fn).catch((error) => console.error(`[pi] ${error.message}`)); };

function frame(s, f) {
  const cb = s.callbacks;
  if (f.t === 'start') cb.onBlockStart(null, f.blockId, f.kind, f.name);
  else if (f.t === 'delta') cb.onDelta(null, f.chunk, f.blockId);
  else if (f.t === 'input') cb.onInputDelta(null, f.chunk, f.blockId);
  else cb.onBlockStop(null, f.blockId);
}

// message_update: text and thinking stream as they come; a tool call is sent whole at its end, as
// the Baton tools it maps to (one edit call can be several Edit cards).
function update(s, e = {}) {
  if (e.type === 'toolcall_end') {
    for (const use of piTools(e.toolCall?.name, e.toolCall?.arguments)) {
      const block = s.next++;
      s.framer.start(block, 'tool_use', use.name);
      s.framer.input(block, JSON.stringify(use.input));
      s.framer.stop(block);
    }
    return;
  }
  const [, kind, phase] = /^(text|thinking)_(start|delta|end)$/.exec(e.type || '') || [];
  if (phase === 'start') s.blocks.set(e.contentIndex, s.next);
  const block = phase === 'start' ? s.next++ : s.blocks.get(e.contentIndex);
  if (block === undefined) return;
  if (phase === 'start') s.framer.start(block, kind, null);
  else if (phase === 'delta') s.framer.delta(block, e.delta || '');
  else s.framer.stop(block);
}

// Baton's tool approvals become tool prompts; any other dialog is a one-question ask.
function dialog(s, r) {
  if (!DIALOGS.has(r.method)) return;
  const multi = r.title === 'baton:multiselect';
  let body = {};
  try { body = JSON.parse((multi ? r.placeholder : r.message) || '{}'); } catch {}
  let request;
  if (r.title === 'baton:permission') {
    const [tool] = piTools(body.toolName, body.input);
    const [, rule, content] = /^(?:(bash):)?(.*)$/.exec(body.grant || '');
    request = { tool_name: tool.name, input: tool.input, permission_suggestions: [{ type: 'addRules', behavior: 'allow',
      rules: [rule ? { toolName: 'Bash', ruleContent: content } : { toolName: tool.name }] }] };
  } else {
    const options = multi ? body.options : r.method === 'confirm' ? ['Yes', 'No'] : r.method === 'select' ? r.options : [];
    const question = { id: 'q', question: multi ? body.question : [r.title, r.method === 'confirm' && r.message].filter(Boolean).join(' — '),
      options: (options || []).map((label) => ({ label: String(label) })), ...(multi ? { multiSelect: true } : {}) };
    request = { tool_name: 'AskUserQuestion', input: { questions: [question] }, requires_user_interaction: true };
  }
  s.dialogs.set(r.id, { method: r.method, multi, grant: r.title === 'baton:permission' ? body.grant : undefined });
  later(s, () => s.callbacks.onControlRequest({ request_id: r.id, request }));
}

function event(nativeId, s, r) {
  if (r.type === 'response') {
    s.waiting.get(r.id)?.(r);
    s.waiting.delete(r.id);
  } else if (r.type === 'message_start' && r.message?.role === 'assistant') {
    s.blocks = new Map();
  } else if (r.type === 'message_update') {
    update(s, r.assistantMessageEvent);
  } else if (r.type === 'message_end') {
    s.framer.finish();
    if (r.message?.batonTurnId) s.sent.delete(r.message.batonTurnId);
    for (const row of piRows({ type: 'message', message: r.message }, s.edits)) {
      // An interrupt from Baton already showed its own row.
      if (s.aborting && row.content?.[0]?.text === INTERRUPT) continue;
      later(s, async () => s.callbacks.onMessage(null, await withImages(row), { normalized: true, runtime: 'pi', liveKey: row.nativeId }));
    }
  } else if (r.type === 'extension_ui_request') {
    dialog(s, r);
  } else if (r.type === 'agent_settled') {
    end(nativeId, s);
  }
}

// The turn is over: prompts Pi never delivered are rejected, and the process exits on EOF.
function end(nativeId, s, error) {
  if (live.get(nativeId) !== s) return;
  live.delete(nativeId);
  s.framer.finish();
  later(s, () => {
    for (const id of s.sent) s.callbacks.rejectInput(id, 'The message was not delivered.');
    if (error) s.callbacks.onError(null, { code: 'exited', detail: error });
    else s.callbacks.onResult(null, {});
  });
  void finishProcess(`pi:${nativeId}`);
}

async function start(launch, nativeId, callbacks, { file, cwd, turnId, text }) {
  const args = [...launch.pre, '--mode', 'rpc', '-e', APPROVAL_EXT, ...(file ? ['--session', file] : ['--session-id', nativeId])];
  const child = await sessionProcess(`pi:${nativeId}`, launch.bin, args, { cwd: existing(cwd),
    env: { ...process.env, BATON_PI_GRANTS: piGrants.file, BATON_PI_SESSION: nativeId } });
  const s = { child, callbacks, sent: new Set([turnId]), dialogs: new Map(), waiting: new Map(), edits: new Map(),
    blocks: new Map(), next: 0, n: 0, queue: Promise.resolve() };
  s.framer = new StreamFramer((f) => later(s, () => frame(s, f)));
  s.rpc = new RpcStdio(child, { onRaw: (r) => event(nativeId, s, r) });
  live.set(nativeId, s);
  ownPids.add(child.pid);
  const gone = () => {
    ownPids.delete(child.pid);
    for (const resolve of s.waiting.values()) resolve({ success: false, error: 'Pi exited' });
    end(nativeId, s, `Pi exited${s.rpc.stderr ? `: ${s.rpc.stderr.trim().slice(-300)}` : ''}`);
  };
  child.once('exit', gone).once('error', gone);
  const r = await request(s, { type: 'prompt', ...prompt(turnId, text) });
  if (!r.success) throw new Error(r.error || 'Pi rejected the prompt');
  callbacks.onAccepted?.();
}

export function createPiInteraction({ launch, findSession, statusRecords }) {
  return defineInteractionAdapter({
    runtime: 'pi',
    owns: (nativeId) => live.has(nativeId),
    isBusy: (nativeId) => live.has(nativeId),

    async sendExisting({ nativeSessionId, streamId, text, cwd, callbacks }) {
      const s = live.get(nativeSessionId);
      if (s) {
        s.sent.add(streamId);
        const r = await request(s, { type: 'prompt', ...prompt(streamId, text), streamingBehavior: 'steer' });
        if (!r.success) throw new Error(r.error || 'Pi rejected the message');
        return;
      }
      const rec = findSession(nativeSessionId);
      if (!rec) throw new Error('Session not found on this device.');
      await start(launch(), nativeSessionId, callbacks, { file: rec.file, cwd: rec.state?.cwd || cwd, turnId: streamId, text });
    },

    async create({ cwd, text, streamId, onCreated }) {
      const nativeSessionId = crypto.randomUUID();
      const callbacks = await onCreated({ nativeSessionId, sessionId: `pi:${nativeSessionId}` });
      await start(launch(), nativeSessionId, callbacks, { cwd, turnId: streamId, text });
    },

    // Queued steers are dropped; abort also ends a waiting dialog (the extension passes its signal).
    async interrupt(nativeId) {
      const s = live.get(nativeId);
      if (!s) return;
      s.aborting = true;
      await request(s, { type: 'clear_queue' });
      const aborted = request(s, { type: 'abort' });
      for (const id of s.dialogs.keys()) later(s, () => s.callbacks.onControlResolved(id));
      s.dialogs.clear();
      await aborted;
    },

    replyControl(nativeId, requestId, { decision, answers, scope }) {
      const s = live.get(nativeId);
      const d = s?.dialogs.get(requestId);
      if (!d) return false;
      s.dialogs.delete(requestId);
      const labels = [].concat(answers?.q ?? []);
      let reply;
      if (d.grant !== undefined) {
        if (decision === 'allow' && scope === 'session') piGrants.add(nativeId, [d.grant]);
        reply = { confirmed: decision === 'allow' };
      } else if (decision !== 'answer') reply = { cancelled: true };
      else if (d.method === 'confirm') reply = { confirmed: labels[0] === 'Yes' };
      else reply = { value: d.multi ? JSON.stringify(labels) : String(labels[0] ?? '') };
      s.rpc.write({ type: 'extension_ui_response', id: requestId, ...reply });
      return true;
    },

    // Another live pi process on the Session (from its status file); only a terminal may be closed.
    heldElsewhere(nativeId) {
      const rec = (statusRecords().get(nativeId) || []).find((r) => !ownPids.has(r.pid));
      return rec ? { pid: rec.pid, status: rec.state === 'idle' ? 'idle' : 'running',
        label: rec.mode === 'tui' ? 'A Pi terminal' : 'Another Pi client', canTerminate: rec.mode === 'tui' } : null;
    },

    // Prompt templates and skills. Pi's built-ins do not run in RPC mode, and extension commands are
    // matched before the turn marker is stripped.
    async listCommands({ cwd }) {
      const key = `pi-commands:${cwd}`;
      const { bin, pre } = launch();
      const child = await sessionProcess(key, bin, [...pre, '--mode', 'rpc', '--no-session'], { cwd: existing(cwd) });
      const s = { n: 0, waiting: new Map() };
      s.rpc = new RpcStdio(child, { onRaw: (r) => { s.waiting.get(r.id)?.(r); s.waiting.delete(r.id); } });
      const gone = () => { for (const resolve of s.waiting.values()) resolve({}); };
      child.once('exit', gone).once('error', gone);
      const r = await request(s, { type: 'get_commands' });
      void finishProcess(key);
      return { commands: (r.data?.commands || []).filter((c) => c.source === 'prompt' || c.source === 'skill')
        .map((c) => ({ name: c.name, description: c.description || '', behavior: 'compose' })), skills: [] };
    },
  });
}
