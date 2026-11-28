import assert from 'node:assert/strict';
import { test } from 'node:test';
import { KEY, WEB, api, devices, headers, skip } from './client.mjs';

const keyed = skip || (!KEY && 'BATON_KEY is unset');

test('version', { skip }, async () => {
  const { version, bridgeVersion } = await api('/api/version');
  assert.ok(typeof version === 'string' && version && typeof bridgeVersion === 'string' && bridgeVersion);
});

test('web files: HTML revalidates, hashed chunks are immutable (#191)', { skip }, async () => {
  const html = await api('/', undefined, { base: WEB });
  assert.equal(headers.get('cache-control'), 'no-cache');
  await api(`/${/assets\/[^"']+-[\w-]{8}\.js/.exec(html)[0]}`, undefined, { base: WEB });
  assert.equal(headers.get('cache-control'), 'public, max-age=31536000, immutable');
});

test('install scripts embed the caller\'s credential; the public one has none', { skip: keyed }, async () => {
  const unix = await api('/api/install', undefined, { token: KEY });
  assert.ok(unix.startsWith('#!/bin/bash') && unix.includes(`BATON_API_KEY='${KEY}'`) && unix.includes(`VALIDATION_KEY='${KEY}'`));
  assert.ok((await api('/api/install?platform=windows', undefined, { token: KEY })).includes(`apiKey = '${KEY}'`));
  // OPEN_REGISTRATION=true: the computer joins by QR code instead.
  const open = await api('/install');
  assert.ok(open.includes('bridge.mjs" pair') && open.includes("BATON_API_KEY=''") && !open.includes(KEY));
  assert.ok((await api('/install?platform=windows')).includes("apiKey = '';"));
});

test('device name validation', { skip: keyed }, async () => {
  const check = (q) => api(`/api/bridge/device-name/validate?${new URLSearchParams(q)}`, undefined, { token: KEY });
  assert.deepEqual(await check({ name: ' ct-ok ' }), { ok: true, name: 'ct-ok', error: '' });
  const identity = "Invalid device name. Use 1-32 characters: letters, numbers, '.', '_' or '-', starting with a letter or number.";
  for (const name of ['-ct', 'ct box', 'c'.repeat(33)]) assert.deepEqual(await check({ name }), { ok: false, name: '', error: identity });
  assert.deepEqual(await check({ name: 'ct Mac ✨', mode: 'display' }), { ok: true, name: 'ct Mac ✨', error: '' });
  assert.equal((await check({ name: 'ct\nMac', mode: 'display' })).error, 'Invalid device name. Use 1-32 visible characters with no line breaks.');
  assert.equal((await check({ name: 'ct', mode: 'other' })).error, 'Invalid validation mode.');
  const taken = (await devices(KEY)).devices[0]?.deviceName; // the self-host account's computers
  if (taken) {
    assert.equal((await check({ name: taken.toUpperCase() })).error, 'That device name is already in use. Choose another.');
    assert.equal((await check({ name: taken, mode: 'display', current: taken })).ok, true);
  }
});
