// Loaded inside dsh by Baton's --patch overlay: ACP has no question channel, so ask_user_question
// (single and multi-select) is answered by the Bridge over fd 3, newline-delimited JSON:
//   dsh → Bridge  { id, questions }   then { id, cancelled: true } if the turn stops first
//   Bridge → dsh  { id, answers: [{ id, selected, custom? }] } or { id, cancelled: true }
// Without fd 3 the answerer is not mounted and dsh behaves as before.
import net from 'node:net';
import { randomUUID } from 'node:crypto';

export const name = 'baton-ask';

const fail = (message, code) => Object.assign(new Error(message), { name: 'UserQuestionError', code });

export function apply(ctx) {
  let pipe;
  try { pipe = new net.Socket({ fd: 3, readable: true, writable: true }); } catch { return; }
  const pending = new Map();
  let buf = '';
  pipe.setEncoding('utf8');
  pipe.on('error', () => {});
  pipe.on('close', () => { for (const done of pending.values()) done(null); pending.clear(); });
  pipe.on('data', (text) => {
    buf += text;
    for (let i = buf.indexOf('\n'); i !== -1; i = buf.indexOf('\n')) {
      let reply;
      try { reply = JSON.parse(buf.slice(0, i)); } catch {}
      buf = buf.slice(i + 1);
      pending.get(reply?.id)?.(reply);
      pending.delete(reply?.id);
    }
  });
  const send = (message) => { if (!pipe.destroyed) pipe.write(`${JSON.stringify(message)}\n`); };

  const off = ctx.on('user-questions/request', async (request, next) => {
    if (!request.agent || pipe.destroyed) return next();
    const id = randomUUID();
    request.signal?.throwIfAborted();
    const reply = await new Promise((resolve, reject) => {
      const abort = () => {
        pending.delete(id);
        send({ id, cancelled: true });
        reject(fail('ask_user_question was aborted before the user answered', 'ASK_ABORTED'));
      };
      request.signal?.addEventListener('abort', abort, { once: true });
      pending.set(id, (value) => { request.signal?.removeEventListener('abort', abort); resolve(value); });
      send({ id, sessionId: String(request.agent.session.id), questions: request.questions });
    });
    if (!reply) throw fail('Baton is not connected', 'PROVIDER_ERROR');
    if (reply.cancelled) throw fail('The user dismissed the question', 'ASK_CANCELLED');
    return { answers: reply.answers };
  });
  ctx.effect(() => () => { off(); pipe.destroy(); }, 'baton-ask');
}
