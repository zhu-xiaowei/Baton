import assert from 'node:assert/strict';
import test from 'node:test';
import { alertFor, completionSummary, configureNotifier, flushQueue, observeSessions } from '../../bridge/notify.mjs';

const ROW = { sessionId: 'codex:session', project: 'project', projectName: 'workspace/github/Baton', deviceName: 'Mac',
  status: 'running', preview: 'Fix login' };
const DONE = { ...ROW, status: 'completed' };
const WAITING = { ...ROW, status: 'needs_input', agentDetail: 'npm test' };
const text = (value, stopReason = 'end_turn') => ({ type: 'assistant', stopReason, content: JSON.stringify([{ type: 'text', text: value }]) });
const user = (content) => ({ type: 'user', content });
// Successive history reads return successive pages (oldest row first, as the Bridge reads them).
function pages(...list) {
  const reads = { count: 0 };
  configureNotifier({ sleep: async () => {}, history: async () => ({ messages: list[Math.min(reads.count++, list.length - 1)] }) });
  return reads;
}

test('status changes alert as the server worker did', async () => {
  pages([user('go'), text('Fixed it.')]);
  const done = await alertFor(ROW, DONE);
  assert.equal(done.title, 'Baton · Fix login');
  assert.equal(done.body, '✅ Done · Fixed it.');
  assert.equal(done.rootSessionId, 'codex:session');
  assert.equal((await alertFor(ROW, WAITING)).body, '🟡 Needs input · npm test');
  assert.ok(await alertFor(WAITING, { ...WAITING, agentDetail: 'rm -rf build' })); // the next approval
  assert.equal(await alertFor(WAITING, WAITING), null);
  assert.equal(await alertFor(undefined, DONE), null); // the first row is a baseline
  assert.equal(await alertFor(DONE, DONE), null);
  assert.equal(await alertFor(ROW, { ...DONE, parentSessionId: 'root' }), null);
  const held = { ...DONE, backgroundAgents: true };
  assert.equal(await alertFor(ROW, held), null);
  assert.equal(await alertFor(held, held), null);
  assert.equal((await alertFor(held, DONE)).body, '✅ Done · Fixed it.');
  // A turn started outside Baton alerts only when the user has left that computer.
  assert.equal(await alertFor(ROW, { ...DONE, localIdleSec: 30 }), null);
  assert.ok(await alertFor(ROW, { ...DONE, localIdleSec: 600 }));
  // A child waiting for input makes its root need input.
  assert.ok(await alertFor(ROW, { ...ROW, needsInputAgentCount: 1 }));
  assert.match((await alertFor(ROW, { ...DONE, preview: '' })).title, /Session session/);
  // Cut by characters: half an emoji makes the server reject the alert.
  pages([user('go'), text('a'.repeat(239) + '😀 tail')]);
  assert.ok((await alertFor(ROW, DONE)).body.endsWith('a😀'));
});

test('the Done text waits for the final reply and skips interrupted or reported-back turns', async () => {
  const thinking = { type: 'assistant', stopReason: 'end_turn', content: JSON.stringify([{ type: 'thinking' }]) };
  let reads = pages([user('go'), thinking], [user('go'), thinking, text('Done.')]);
  assert.equal(await completionSummary('s'), 'Done.');
  assert.equal(reads.count, 2);
  reads = pages([user('go'), text('Checking', 'tool_use')]);
  assert.equal(await completionSummary('s'), 'Checking'); // best effort after the retries
  assert.equal(reads.count, 3);
  pages([user(JSON.stringify([{ type: 'text', text: '[Request interrupted by user]' }]))]);
  assert.equal(await alertFor(ROW, DONE), null);
  pages([text('4/5'), user('<task-notification>')]);
  assert.equal(await completionSummary('s'), null); // CC's report-back turn alerts when it ends
  pages([user('<task-notification>'), text('All done.')]);
  assert.equal(await completionSummary('s'), 'All done.');
  reads = pages([user('go'), text('Done.', null), { type: 'assistant', stopReason: 'end_turn', content: '[]' }]);
  assert.equal(await completionSummary('s'), 'Done.'); // Codex's empty end marker
  assert.equal(reads.count, 1);
  pages([user('<local-command-stdout>Review result</local-command-stdout>')]);
  assert.equal(await completionSummary('s'), 'Review result');
});

test('reported rows alert once, not while viewed, and are queued while the server is away', async () => {
  pages([user('go'), text('Fixed it.')]);
  const posted = [];
  let viewed = true;
  let online = false;
  configureNotifier({
    viewed: async () => viewed,
    post: async (endpoint, alert) => { posted.push(alert); return online ? { status: 200 } : null; },
  });
  const report = (sessions, extra = {}) => observeSessions({ deviceName: 'Mac', sessions, ...extra });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 10));
  const row = { id: 'a', runtime: 'claude', project: 'p', projectName: 'p', status: 'running', preview: 'A' };
  report([row]);
  report([{ ...row, status: 'completed' }]);
  await settle();
  assert.equal(posted.length, 0); // open and focused somewhere
  viewed = false;
  report([row]);
  report([{ ...row, status: 'completed' }]);
  await settle();
  assert.equal(posted.length, 1);
  online = true;
  await flushQueue();
  assert.equal(posted.length, 2); // the queued alert goes out once the server answers
  await flushQueue();
  assert.equal(posted.length, 2);
  // Count updates change the stored root only.
  report([], { agentCountUpdates: [{ sessionId: 'a', project: 'p', needsInputAgentCount: 1 }] });
  await settle();
  assert.match(posted.at(-1).body, /Needs input/);
});
