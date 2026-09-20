(() => {
  const nativeFetch = window.fetch.bind(window);
  const NativeWebSocket = window.WebSocket;
  const sessionId = 'codex:browser-snapshot';
  const probe = window.snapshotProbe = {
    requests: [], sends: [], sockets: [], waiting: [], hold: true, fail: false,
  };
  window.__APEEK_TEST__ = true;
  localStorage.setItem('_ak', btoa('snapshot-test'));
  localStorage.setItem('_as', location.origin);
  localStorage.setItem('_wsurl', 'wss://snapshot.test/ws');
  sessionStorage.clear();

  probe.history = (start, count = 200) => Array.from({ length: count }, (_, offset) => {
    const index = start + offset;
    const turn = Math.floor(index / 4);
    const toolId = 'tool-' + turn;
    const message = {
      uuid: 'message-' + index,
      timestamp: new Date(Date.UTC(2026, 8, 20, 0, 0, index)).toISOString(),
    };
    if (index % 4 === 0) return {
      ...message, nativeId: 'codex:user:turn-' + turn, type: 'user',
      content: 'Question ' + turn + ': inspect the current implementation',
    };
    if (index % 4 === 1) return {
      ...message, type: 'assistant',
      content: [{ type: 'text', text: 'Answer ' + turn + ': **checking the implementation** before making a focused change.' }],
    };
    if (index % 4 === 3) return {
      ...message, type: 'user',
      content: [{ type: 'tool_result', tool_use_id: toolId, content: 'Completed successfully.' }],
    };
    return {
      ...message, type: 'assistant',
      content: [{ type: 'tool_use', id: toolId,
        name: turn % 10 === 9 ? 'Edit' : 'Bash',
        input: turn % 10 === 9
          ? { file_path: '/workspace/example.js', old_string: 'const pageSize = 100;', new_string: 'const pageSize = 200;' }
          : { command: 'printf "check ' + turn + '\\n"', description: 'Inspect step ' + turn },
      }],
    };
  });
  probe.snapshot = probe.history(0);
  probe.release = () => {
    probe.hold = false;
    for (const resolve of probe.waiting.splice(0)) resolve();
  };
  probe.event = event => {
    const socket = probe.sockets.at(-1);
    socket.onmessage?.({ data: JSON.stringify({ sessionId, ...event }) });
  };
  probe.complete = (pending, number) => {
    const user = {
      uuid: 'prompt-' + pending.turnId, nativeId: 'codex:user:' + pending.turnId,
      type: 'user', content: String(number),
    };
    const assistant = {
      uuid: 'answer-' + pending.turnId, type: 'assistant',
      content: [{ type: 'text', text: 'Reply to ' + number }],
    };
    const events = [
      { action: 'stream_turn_start', seq: 0 },
      { action: 'messages', seq: 1, messages: [user] },
      { action: 'stream_block_start', seq: 2, kind: 'text' },
      { action: 'stream_delta', seq: 3, chunk: 'Reply to ' + number },
      { action: 'stream_block_stop', seq: 4 },
      { action: 'messages', seq: 5, messages: [assistant] },
      { action: 'stream_end', seq: 6, messages: [user, assistant] },
    ];
    for (const index of [0, 2, 3, 4, 5, 6, 1]) {
      probe.event({ turnId: pending.turnId, ...events[index] });
    }
  };

  window.fetch = async (input, options) => {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    if (!url.pathname.startsWith('/api/bridge/')) return nativeFetch(input, options);
    let body = { devices: [], sessions: [], projects: [], threads: [] };
    if (url.pathname.endsWith('/config')) body = { wsUrl: 'wss://snapshot.test/ws' };
    if (url.pathname.endsWith('/messages')) {
      probe.requests.push(Object.fromEntries(url.searchParams));
      if (probe.hold) await new Promise(resolve => probe.waiting.push(resolve));
      if (probe.fail) return new Response('offline', { status: 503 });
      body = {
        messages: probe.snapshot, hasMore: false,
        oldestTimestamp: probe.snapshot[0]?.uuid || '', status: 'completed',
      };
    }
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  };

  window.WebSocket = class {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    constructor(url, protocols) {
      if (!String(url).startsWith('wss://snapshot.test/')) return new NativeWebSocket(url, protocols);
      this.readyState = 0;
      probe.sockets.push(this);
      setTimeout(() => { this.readyState = 1; this.onopen?.(); }, 10);
    }
    send(payload) {
      const message = JSON.parse(payload);
      probe.sends.push(message);
      if (message.action === 'send_message') {
        setTimeout(() => this.onmessage?.({ data: JSON.stringify({
          action: 'send_message_received', sessionId, turnId: message.turnId,
        }) }), 0);
      }
    }
    close() { this.readyState = 3; this.onclose?.(); }
  };
})();
