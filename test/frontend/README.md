# Frontend streaming tests

The streaming suite drives the real `web/js/ws.js` dispatcher in jsdom.

The live protocol has one ordering rule:

```text
turnId identifies the turn
seq orders every shared event in that turn
```

`TurnEventQueue` receives all live `stream_*`, strict `messages`, and permission
events before the renderer sees them. Tests cover:

- all permutations of a complete turn;
- duplicate and conflicting sequence numbers;
- stop, authority, and end arriving before missing deltas;
- `seq=1` recovery, missed-node authority, and next-block late-join recovery;
- REST history merging with strict and no-seq WS messages;
- sequential block reveal;
- rapid identical prompts remaining attached to their own `turnId` anchors;
- authoritative content patching an existing node without replacing it;
- permission recovery without replaying ordinary streaming nodes;
- interruption placement, observer delivery, history persistence, and end-authority
  deduplication.

Run:

```bash
npm run test:frontend
```
