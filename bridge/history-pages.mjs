// History pages for the `history` RPC and child threads for `threads`, computed in the history worker.
// Readers stay open per file.
import { discoverClaudeSubagents } from './claude-subagent.mjs';
import { scanCodexRollout } from './codex-session.mjs';
import { nativeOrderKey } from './extract.mjs';
import { ClaudeHistoryReader } from './history-claude-reader.mjs';
import { CodexHistoryReader } from './history-codex-reader.mjs';
import { orderKeyLine } from './history-line-index.mjs';
import { slimRow } from './history-slim.mjs';
import { runtimeDescriptor } from './session-identity.mjs';

const MAX_READERS = 32;
const PAGE_LIMIT = 200;
const MAX_LIMIT = 500;

export function createHistoryPages() {
  const readers = new Map(); // file → reader, least recently used first

  function readerFor(target) {
    const { file, runtime, nativeSessionId } = target;
    let reader = readers.get(file);
    if (reader) readers.delete(file);
    else if (runtimeDescriptor(runtime)) reader = runtimeDescriptor(runtime).history(target);
    else reader = runtime === 'codex' ? new CodexHistoryReader(file, nativeSessionId) : new ClaudeHistoryReader(file);
    readers.set(file, reader);
    if (readers.size > MAX_READERS) readers.delete(readers.keys().next().value);
    reader.update();
    return reader;
  }

  // The newest row the next `after` may start from: rows after it can still change.
  async function stableCursor(reader, page, after) {
    const line = reader.stableLine();
    if (line === Infinity) return page.at(-1)?.orderKey || after || null;
    const before = page.findLast((row) => orderKeyLine(row.orderKey) < line);
    if (before) return before.orderKey;
    return (await reader.page({ before: nativeOrderKey(line), limit: 1 })).at(-1)?.orderKey || null;
  }

  // The newest `limit` rows in (after, before). A cursor from another file version, or past the end,
  // starts over with the latest page and says so.
  async function history(target, params = {}) {
    const reader = readerFor(target);
    const limit = Math.min(Math.max(1, Number(params.limit) || PAGE_LIMIT), MAX_LIMIT);
    const outside = (cursor) => !!cursor && !(orderKeyLine(cursor) < reader.index.count);
    const reset = (!!params.epoch && params.epoch !== reader.epoch) || outside(params.before) || outside(params.after);
    const before = reset ? undefined : params.before || undefined;
    const after = reset ? undefined : params.after || undefined;
    const rows = await reader.page({ before, after, limit: limit + 1 });
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(1) : rows;
    const result = {
      messages: page.map(slimRow),
      hasMore,
      oldestTimestamp: page[0]?.orderKey || '',
      epoch: reader.epoch,
    };
    if (!before) { // the page reaches the end of the transcript
      result.stableCursor = await stableCursor(reader, page, after);
      if (reader.titles) result.titles = (await reader.titles()).map(slimRow);
    }
    if (reset) result.historyReset = true;
    return result;
  }

  async function warm(target) {
    await readerFor(target).page({ limit: PAGE_LIMIT });
  }

  // Child threads of a root: Claude subagents, or the given Codex child rollouts (both parse whole files).
  function children({ runtime, dir, id, project, status, backgroundAgents, codex = [] }) {
    if (runtime === 'claude') return discoverClaudeSubagents(dir, { nativeSessionId: id, project, status, backgroundAgents });
    return codex.map((child) => scanCodexRollout(child.file, { nativeSessionId: child.id, threadName: child.threadName }).session)
      .filter(Boolean);
  }

  return { history, warm, children };
}
