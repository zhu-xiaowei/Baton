import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';
import { JSDOM } from 'jsdom';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('Claude usage panel navigates tabs, stats views, ranges, and copies text', async () => {
  const dom = new JSDOM('<!doctype html><body><div id="root"></div></body>', {
    url: 'https://test/',
  });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.navigator = dom.window.navigator;
  let copied = '';
  Object.defineProperty(dom.window.navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText(value) {
        copied = value;
        return Promise.resolve();
      },
    },
  });

  await import(
    pathToFileURL(path.join(ROOT, 'web/js/components/claude-usage.js')).href
      + `?test=${Date.now()}`,
  );
  const panel = {
    type: 'claude-usage',
    initialTab: 'stats',
    rawText: 'raw usage text',
    status: {
      items: [{ label: 'Version', value: '2.1.233' }],
      diagnostics: [],
    },
    config: {
      applied: [{ key: 'model', value: 'opus' }],
      effective: [{ key: 'theme', value: 'dark' }],
      sources: [],
    },
    usage: {
      items: [{ label: 'Total cost', value: '$1.0000' }],
      rateLimitsAvailable: false,
    },
    stats: {
      today: '2026-08-15',
      ranges: [{
        key: 'all',
        label: 'All time',
        summary: {
          totalTokens: 1200,
          sessions: 3,
          activeDays: 2,
          periodDays: 4,
          longestSessionMs: 120000,
          longestStreak: 2,
          currentStreak: 1,
          mostActiveDay: '2026-08-15',
        },
        tokenBreakdown: { input: 500, output: 100, cacheCreation: 300, cacheRead: 300 },
        days: [{ date: '2026-08-15', tokens: 1200, sessions: 3 }],
        modelChart: {
          unit: 'day',
          labels: ['2026-08-14', '2026-08-15'],
          series: [{
            id: 'model-opus',
            label: 'Opus',
            total: 1200,
            values: [200, 1000],
          }],
        },
        models: [{
          id: 'model-opus',
          label: 'Opus',
          total: 1200,
          input: 500,
          output: 100,
          cacheCreation: 300,
          cacheRead: 300,
        }],
      }, {
        key: '7d',
        label: 'Last 7 days',
        summary: {
          totalTokens: 200,
          sessions: 1,
          activeDays: 1,
          periodDays: 7,
          longestSessionMs: 60000,
          longestStreak: 1,
          currentStreak: 1,
          mostActiveDay: '2026-08-15',
        },
        tokenBreakdown: { input: 100, output: 20, cacheCreation: 40, cacheRead: 40 },
        days: [{ date: '2026-08-15', tokens: 200, sessions: 1 }],
        modelChart: { unit: 'day', labels: [], series: [] },
        models: [],
      }],
    },
  };

  const root = dom.window.document.getElementById('root');
  root.innerHTML = dom.window.renderClaudeUsagePanel(panel);
  assert.equal(root.querySelector('.cc-panel-tab.active').dataset.tab, 'stats');
  assert.match(root.textContent, /Overview/);
  assert.match(root.textContent, /Opus/);

  const status = [...root.querySelectorAll('.cc-panel-tabs button')]
    .find((button) => button.textContent === 'Status');
  dom.window.switchClaudeUsageTab(status, 'status');
  assert.equal(root.querySelector('.cc-panel-tab.active').dataset.tab, 'status');
  assert.match(root.querySelector('.cc-panel-tab.active').textContent, /2.1.233/);

  const stats = [...root.querySelectorAll('.cc-panel-tabs button')]
    .find((button) => button.textContent === 'Stats');
  dom.window.switchClaudeUsageTab(stats, 'stats');
  const models = [...root.querySelectorAll('.cc-subtabs button')]
    .find((button) => button.textContent === 'Models');
  dom.window.switchClaudeStatsView(models, 'models');
  assert.equal(root.querySelector('.cc-stats-view.active').dataset.view, 'models');
  assert.match(root.querySelector('.cc-stats-view.active').textContent, /1.2k tokens/);
  assert.ok(root.querySelector('.cc-model-chart'));
  assert.match(root.querySelector('.cc-model-chart').getAttribute('aria-label'), /usage over time/);
  assert.match(root.querySelector('.cc-model-chart-block').textContent, /Opus/);

  const last7 = root.querySelector('.cc-range-tabs button[data-range="7d"]');
  dom.window.switchClaudeStatsRange(last7, '7d');
  assert.equal(root.querySelector('.cc-stats-range.active').dataset.range, '7d');
  assert.match(root.querySelector('.cc-stats-range.active').textContent, /No model usage recorded/);

  dom.window.copyClaudeUsagePanel(root.querySelector('.cc-panel-copy'));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(copied, 'raw usage text');
});
