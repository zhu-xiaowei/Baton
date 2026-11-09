// The newest `limit` rows in the open interval (after, before), walking back in line windows.
import { orderKeyLine } from './line-index.mjs';

export async function readPage(reader, { after, before, limit }, firstWindow, maxWindow) {
  const stop = after ? orderKeyLine(after) : 0;
  let hi = before ? orderKeyLine(before) + 1 : reader.index.count;
  let rows = [];
  for (let step = firstWindow; hi > stop && rows.length < limit; step = Math.min(step * 2, maxWindow)) {
    const lo = Math.max(stop, hi - step);
    const found = (await reader.rows(lo, hi))
      .filter((row) => (!after || row.orderKey > after) && (!before || row.orderKey < before));
    rows = found.concat(rows);
    hi = lo;
  }
  return Number.isFinite(limit) ? rows.slice(-limit) : rows;
}
