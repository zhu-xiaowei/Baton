import { DDB_ITEM_LIMIT, WS_FRAME_LIMIT } from './config.mjs';
import { truncateToBytes, uploadMessages } from './extract.mjs';
import { wsSend, wsSendWithAck } from './ws.mjs';

export async function deliverRealtimeMessages(sessionId, messages, options = {}) {
  const send = options.wsSendFn || wsSend;
  const sendWithAck = options.wsSendWithAckFn || wsSendWithAck;
  const upload = options.uploadMessagesFn || uploadMessages;
  const frameLimit = options.frameLimit || WS_FRAME_LIMIT;
  const itemLimit = options.itemLimit || DDB_ITEM_LIMIT;
  const identity = {
    ...(options.runtime ? { runtime: options.runtime } : {}),
    ...(options.nativeSessionId ? { nativeSessionId: options.nativeSessionId } : {}),
  };
  let batch = [];

  const flush = async () => {
    if (!batch.length) return;
    const outgoing = batch;
    batch = [];
    const acked = await sendWithAck({
      action: 'messages',
      sessionId,
      messages: outgoing,
    });
    if (!acked) await upload(sessionId, outgoing, identity);
  };

  for (const raw of messages) {
    const message = truncateToBytes(raw, itemLimit);
    const envelope = { action: 'messages', sessionId, messages: [message] };
    if (Buffer.byteLength(JSON.stringify(envelope)) > frameLimit) {
      await flush();
      const preview = truncateToBytes(message, frameLimit - 512);
      preview.truncated = true;
      send({ action: 'messages', sessionId, messages: [preview], noCache: true });
      await upload(sessionId, [message], identity);
      continue;
    }

    const candidate = {
      action: 'messages',
      sessionId,
      messages: [...batch, message],
    };
    if (batch.length && Buffer.byteLength(JSON.stringify(candidate)) > frameLimit) {
      await flush();
    }
    batch.push(message);
  }

  await flush();
}
