import assert from 'node:assert/strict';
import { test } from 'node:test';
import { accountCost, nextMonth, projected, serviceCost } from '../../server/cloudflare/cost.mjs';

test('an account object costs requests, WebSocket messages at 20:1, duration and rows', () => {
  // 1M HTTP calls ($0.30 Worker + $0.15 DO), 2M messages = 100k requests ($0.015), 10k GB-s ($0.125), 1M rows written ($1)
  const cost = accountCost({ http: 1e6, calls: 1e6, wsIn: 2e6, gbSec: 10e3, rowsWritten: 1e6 });
  assert.ok(Math.abs(cost - 1.59) < 1e-9, String(cost));
});

test('the service bill is $5 plus usage beyond what Paid includes; projections run to the 1st of next month', () => {
  assert.deepEqual(serviceCost({ doRequests: 2e6 }), { usage: 0.3, items: { doRequests: 0.3 }, bill: 5.15 });
  assert.equal(projected(10, new Date(Date.UTC(2026, 10, 16))), 20);
  assert.equal(nextMonth(new Date(Date.UTC(2026, 11, 31, 23))), Date.UTC(2027, 0, 1));
});
