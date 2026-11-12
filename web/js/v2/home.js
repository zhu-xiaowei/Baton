// Home: device names/online from /devices (server), everything else from each Bridge.
// Produces the shapes the home page renders (former /active-sessions and /devices).
import { state } from '../state.js';
import { showToast } from '../components/toast.js';
import { confirmDialog } from '../components/confirm-dialog.js';
import { cachedOnlineDevices, connect, devices, request } from './direct-transport.js';

const CACHE_KEY = 'apeek_v2_home_devices';
const PROJECT_LIMIT = 15;
let inflight = null;
let latest = null;
let generation = 0; // only the newest load writes the cache and the page

function readJson(key) {
  try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; }
}

// Per-device answers plus the last /devices list, so a re-entry can merge before /devices answers.
function readCache() {
  const saved = readJson(CACHE_KEY);
  return saved?.server === state.SERVER ? saved : {};
}

function saveCache(devices, list) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify({ server: state.SERVER, devices, list })); } catch {}
}

let outdated = null; // the server-update dialog, shown once

// "Show more" only reveals projects the last answer already holds (15), so it sends nothing.
export function expandedHome() {
  return latest ? Promise.resolve(latest) : loadHomeV2();
}

export function loadHomeV2() {
  if (inflight && performance.now() - inflight.at < 1500) return inflight.promise;
  const promise = run().finally(() => { if (inflight?.promise === promise) inflight.at = 0; });
  inflight = { at: performance.now(), promise };
  return promise;
}

// Resolves as soon as the page can be updated: on a re-entry once the Bridges answered (using the
// cached device list), otherwise once /devices answered too. A later /devices change re-renders
// through window.__applyHome.
function run() {
  return new Promise((resolve, reject) => { load(resolve).then(resolve, reject); });
}

async function load(publish) {
  const started = performance.now();
  const gen = ++generation;
  const current = () => gen === generation;
  window.__v2Timings = {};
  const saved = readCache();
  const cache = saved.devices || {};
  const fresh = new Map();
  const asked = new Map();
  const timedOut = new Set();
  let finished = null; // { list, reachable } once the home is published from /devices
  // A device still silent at 6 s shows its cached answer; a reply by 12 s updates the home, a
  // timeout at 12 s is reported. The wait for each device ends at whichever comes first.
  const ask = (device) => {
    if (asked.has(device)) return;
    const known = cache[device]?.answer;
    let settle;
    asked.set(device, new Promise((resolve) => { settle = resolve; }));
    request(device, 'home', { revision: known?.revision }, { onSlow: () => settle() }).then((answer) => {
      if (!answer.notModified) cache[device] = { answer, at: Date.now() };
      if (cache[device]) fresh.set(device, cache[device]);
      settle();
      if (finished && current() && !answer.notModified) {
        saveCache(cache, finished.list);
        latest = merge(finished.list, finished.reachable);
        window.__applyHome?.(latest.active, latest.devices);
      }
    }, (error) => {
      if (error.message === 'timeout') timedOut.add(device);
      settle();
      if (finished) reportSilent();
    });
  };
  // Offline devices already say so on their row; only an online device that stayed silent is news.
  // An open Session reports its own timeout.
  const reportSilent = () => {
    const silent = finished.list.filter((device) => device.online && timedOut.has(device.deviceName))
      .map((device) => device.deviceDisplayName || device.deviceName);
    if (silent.length && !state.appState.session) showToast((silent.length > 2 ? silent.length + ' devices' : silent.join(', ')) + ' not responding');
  };
  const answerFor = (name) => (fresh.get(name) || cache[name])?.answer;
  const merge = (list, reachable) => ({ active: mergeActive(list, answerFor, reachable), devices: mergeDevices(list, answerFor, reachable) });
  connect(); // the socket's handshake overlaps /devices
  cachedOnlineDevices().forEach(ask);
  // Route changes (offline, new address) must reach pending requests at once.
  let listed = false;
  const devicesRequest = devices().then((response) => {
    listed = true;
    window.__v2Timings.devices = Math.round(performance.now() - started);
    return response;
  });
  let early = null;
  if (saved.list && asked.size) await Promise.all(asked.values());
  // Publish from the cached list only when the Bridges beat /devices; otherwise use the fresh list.
  if (saved.list && asked.size && !listed) {
    // Only devices that answered just now are live; one that answered is online whatever the cache said.
    const answered = new Set(fresh.keys());
    early = latest = merge(saved.list.map((d) => (answered.has(d.deviceName) ? { ...d, online: true } : d)), answered);
    window.__v2Timings.total = Math.round(performance.now() - started);
    publish(early);
  }
  let response;
  try {
    response = await devicesRequest;
  } catch (error) {
    if (early) return early;
    throw error;
  }
  if (response.protocol !== 2) {
    outdated ||= confirmDialog('Server update required', [['settings', 'Settings'], ['retry', 'Retry', true]], null,
      'Run the install command again to update your Baton stack.')
      .then((choice) => { if (choice === 'retry') location.reload(); else location.href = 'setup.html'; });
    throw new Error('server_outdated');
  }
  const reachable = new Set((response.rpc?.bridges || []).map((bridge) => bridge.device));
  for (const device of response.devices) if (device.online && reachable.has(device.deviceName)) ask(device.deviceName);
  await Promise.all(asked.values());
  if (current()) saveCache(cache, response.devices);
  finished = { list: response.devices, reachable };
  reportSilent();
  const result = merge(response.devices, reachable);
  if (current()) latest = result;
  window.__v2Timings.fresh = [...fresh.keys()];
  if (!early) window.__v2Timings.total = Math.round(performance.now() - started);
  else if (current() && JSON.stringify(result) !== JSON.stringify(early)) window.__applyHome?.(result.active, result.devices);
  return result;
}

// A device the App cannot ask (offline, or online without a joined Bridge) keeps its cached
// project count and time, but nothing is shown as running or waiting.
function mergeDevices(list, answerFor, reachable) {
  const devices = list.map((device) => {
    const answer = answerFor(device.deviceName);
    const live = device.online && reachable.has(device.deviceName);
    return { deviceName: device.deviceName, deviceDisplayName: device.deviceDisplayName, os: device.os,
      online: device.online, ...(answer ? answer.device : {}), ...(answer && !live ? { runningCount: 0, needsInputCount: 0 } : {}) };
  });
  devices.sort((a, b) => ((a.lastActive || '') < (b.lastActive || '') ? 1 : (a.lastActive || '') > (b.lastActive || '') ? -1 : 0));
  return { devices };
}

function mergeActive(list, answerFor, reachable) {
  const sessions = [];
  const projects = [];
  for (const device of list) {
    const answer = answerFor(device.deviceName);
    if (!answer) continue;
    const deviceName = device.deviceName;
    if (device.online && reachable.has(deviceName)) for (const session of answer.sessions) sessions.push({ ...session, deviceName });
    for (const project of answer.recentProjects) {
      projects.push({ ...project, deviceName, sessions: project.sessions.map((session) => ({
        ...session, deviceName, projectHash: project.projectHash, projectName: project.projectName })) });
    }
  }
  const newestFirst = (a, b) => (a.lastActive < b.lastActive ? 1 : a.lastActive > b.lastActive ? -1 : 0);
  sessions.sort(newestFirst);
  projects.sort(newestFirst);
  return { sessions, recentSessions: [], recentProjects: projects.slice(0, PROJECT_LIMIT), hasMoreProjects: false };
}
