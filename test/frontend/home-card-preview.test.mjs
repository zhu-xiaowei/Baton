import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { JSDOM } from 'jsdom';

const ROOT = path.resolve(import.meta.dirname, '../..');
const indexHtml = fs.readFileSync(path.join(ROOT, 'web/index.html'), 'utf8');

async function waitFor(predicate) {
  for (var i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise(function (resolve) { setTimeout(resolve, 5); });
  }
  throw new Error('Timed out waiting for inline home render');
}

test('inline home cards preserve quoted session previews for detail navigation', async () => {
  const preview = '{"action":"send_message","text":"quoted title"}';
  const active = {
    sessions: [{
      sessionId: 'codex:test-session',
      preview,
      status: 'running',
      deviceName: 'MacBook-Pro',
      projectHash: '-workspace-agentpeek',
      projectName: 'agentpeek',
      runtime: 'codex',
      lastActive: '2026-08-12T00:00:00.000Z',
    }],
    recentSessions: [],
  };
  const devices = { devices: [] };
  const dom = new JSDOM(indexHtml, {
    url: 'http://agentpeek.test/index.html',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(window) {
      window.localStorage.setItem('_ak', window.btoa('test-key'));
      window.fetch = async function (url) {
        return {
          ok: true,
          json: async function () {
            return String(url).includes('active-sessions') ? active : devices;
          },
        };
      };
    },
  });

  try {
    await waitFor(function () {
      return dom.window.document.querySelector('.active-card[data-nav="active"]');
    });
    assert.equal(
      dom.window.document.querySelector('.active-card[data-nav="active"]').dataset.preview,
      preview,
    );
  } finally {
    dom.window.close();
  }
});
