# Sending Messages While a Turn Is Running

The Bridge hands ordinary messages to the runtime immediately instead of waiting for the previous turn to finish generating. Users can still stop a task explicitly, but they no longer have to press Esc before adding input.

## Minimal Loop

- Codex calls `turn/start` when idle, and `turn/steer` with the real `expectedTurnId` while a turn is active. Only initialization, resume, and submit RPCs are serialized, not generation. An explicit no-active rejection may be re-checked and then submitted; unknown delivery outcomes such as timeouts are never blindly resent.
- Claude Code writes UUID-tagged input directly into the same stream-json stdin and enables `--replay-user-messages`. Input added mid-run does not replace the output callback or reset the framer. `user_message_uuids` settles the input that was actually consumed; `queued_turn_count=0` does not mean every written message has completed.
- Send IDs, native execution IDs, and display-segment IDs are separate. The canonical user message decides display-segment boundaries, reusing the existing `LiveTurnStream`, coordinator, and DOM renderer. The end of a display segment is not the end of execution.
- Canonical messages, deltas, block boundaries, and ends keep their order in a single publish queue. `executionSeq` ensures network reordering across display segments cannot change the native order; the existing per-segment `seq`, fetch barrier, late-join, and history recovery all remain.

## Identity and Order

One native Codex turn can contain several distinct user items, so the native turn ID cannot be used for deduplication. Display anchors are derived deterministically from the client ID or item UUID.

Codex publishes tool input with a stable identity as soon as the native `item/started` arrives, binding the tool to the display segment in which it started. Tool-completion records that arrive after an interjection update that same position by identity; they are not moved after the new user message and do not leave a running card behind.

Messages inserted while a CC tool is executing may be persisted as `attachment.queued_command` and normalized with `source_uuid` and `prompt`. Several sends during text output may also be merged; only one canonical user row is stored. Input replays without a timestamp only confirm consumption and do not create extra chat bubbles.

A successful send ACK only means the input was submitted, not that generation finished. In-process retries with the same send ID are submitted once; the same text with a different ID is two different inputs. This is not an exactly-once guarantee across Bridge restarts.

## History Cache Upgrade

JSONL file order is authoritative; timestamps are for display only. The extractor builds `O2#…` sort keys from line numbers and fragment indexes, and WS persistence and HTTP persistence use the same key builder.

The new cache is written to a separate `native-order-v2` partition; the version pointer is published only after every batch of a full sync succeeds. Before publication, the old cache is still read and a full sync is requested, so old and new sort keys are never mixed in one paged query. After publication, old cursors return `historyReset` and the page reloads the latest history.

Old messages are not deleted; they keep expiring under the original TTL. Watermarks saved by the Bridge carry `historyVersion: 2`; during the upgrade an old watermark does not skip native history that must be rebuilt. Full syncs and later incremental writes are all deterministic upserts.

## Preserved Boundaries

`ClientTurnOrder`, the short submit lock, the persisted ACK queue, the single-writer check, permission replies, and explicit interrupts are all kept. CC local slash commands issued during an active turn are not mixed into the ordinary message stream; status/statistics panels that need no runtime execution remain available.

Steer is native scheduling and does not guarantee immediate preemption of a running tool. Web ordering follows the position at which the runtime actually received and persisted the input, not the time the button was clicked.
