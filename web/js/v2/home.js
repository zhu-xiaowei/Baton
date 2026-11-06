// v2 home: device names/online from /devices (server), everything else from each Bridge.
// Produces the same shapes as v1 /active-sessions and /devices so the page renders unchanged.
import { state } from '../state.js';
import { cachedOnlineDevices, connect, request, updateRoutes } from './direct-transport.js';

const PROTOCOL_KEY = 'baton-proto';
const CACHE_KEY = 'apeek_v2_home_devices';
const PROJECT_LIMIT = 15;
let inflight = null;

function readJson(key) {
  try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; }
}

// 2 = v2 server, 1 = v1 server or forced, 0 = not known yet.
export function serverProtocol() {
  if (localStorage.getItem('baton-force-v1') === '1') return 1;
  const saved = readJson(PROTOCOL_KEY);
  return saved?.server === state.SERVER ? saved.protocol : 0;
}

function rememberProtocol(response) {
  const protocol = response?.protocol === 2 ? 2 : 1;
  try {
    localStorage.setItem(PROTOCOL_KEY, JSON.stringify({ server: state.SERVER, protocol, dataUrl: response?.dataUrl || '' }));
  } catch {}
}

async function rest(path, params) {
  const query = params ? '?' + new URLSearchParams(params) : '';
  const response = await fetch(state.SERVER + path + query, { headers: { 'x-api-key': state.KEY } });
  if (response.status === 401 || response.status === 403) window.logout?.();
  if (!response.ok) throw new Error(response.status + ' ' + response.statusText);
  return response.json();
}

function cachedAnswers() {
  const saved = readJson(CACHE_KEY);
  return saved?.server === state.SERVER ? saved.devices || {} : {};
}

function saveAnswers(devices) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify({ server: state.SERVER, devices })); } catch {}
}

export function loadHomeV2() {
  if (inflight && performance.now() - inflight.at < 1500) return inflight.promise;
  const promise = run().finally(() => { if (inflight?.promise === promise) inflight.at = 0; });
  inflight = { at: performance.now(), promise };
  return promise;
}

async function run() {
  const started = performance.now();
  window.__v2Timings = {};
  const cache = cachedAnswers();
  const fresh = new Map();
  const asked = new Map();
  const ask = (device) => {
    if (asked.has(device)) return;
    const known = cache[device]?.answer;
    asked.set(device, request(device, 'home', { revision: known?.revision }).then((answer) => {
      if (!answer.notModified) cache[device] = { answer, at: Date.now() };
      if (cache[device]) fresh.set(device, cache[device]);
    }, () => {}));
  };
  if (serverProtocol() === 2) {
    connect(readJson(PROTOCOL_KEY)?.dataUrl);
    cachedOnlineDevices().forEach(ask);
  }
  const devicesResponse = await rest('/api/bridge/devices');
  window.__v2Timings.devices = Math.round(performance.now() - started);
  rememberProtocol(devicesResponse);
  if (devicesResponse.protocol !== 2) {
    return { active: await rest('/api/bridge/active-sessions'), devices: devicesResponse };
  }
  connect(devicesResponse.dataUrl);
  updateRoutes(devicesResponse);
  window.__renderHomeDevices?.(mergeDevices(devicesResponse, (name) => cache[name]?.answer));
  const reachable = new Set((devicesResponse.rpc?.bridges || []).map((bridge) => bridge.device));
  for (const device of devicesResponse.devices) if (device.online && reachable.has(device.deviceName)) ask(device.deviceName);
  await Promise.all(asked.values());
  saveAnswers(cache);
  const answerFor = (name) => (fresh.get(name) || cache[name])?.answer;
  const result = { active: mergeActive(devicesResponse, answerFor), devices: mergeDevices(devicesResponse, answerFor) };
  window.__v2Timings.total = Math.round(performance.now() - started);
  window.__v2Timings.fresh = [...fresh.keys()];
  console.log('[v2] home', window.__v2Timings);
  return result;
}

function mergeDevices(response, answerFor) {
  const devices = response.devices.map((device) => {
    const answer = answerFor(device.deviceName);
    const out = { deviceName: device.deviceName, deviceDisplayName: device.deviceDisplayName, os: device.os,
      online: device.online, projectCount: device.projectCount, runningCount: device.runningCount,
      needsInputCount: device.needsInputCount, lastActive: device.lastActive };
    if (answer) Object.assign(out, answer.device);
    return out;
  });
  devices.sort((a, b) => (a.lastActive < b.lastActive ? 1 : a.lastActive > b.lastActive ? -1 : 0));
  return { devices };
}

function mergeActive(response, answerFor) {
  const sessions = [];
  const projects = [];
  for (const device of response.devices) {
    const answer = answerFor(device.deviceName);
    if (!answer) continue;
    const deviceName = device.deviceName;
    if (device.online) for (const session of answer.sessions) sessions.push({ ...session, deviceName });
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

// Dev check: v2 against the v1 REST answer on the same stack (active sessions and device counts).
window.compareHomeV1V2 = async function () {
  const [v2, v1Active, v1Devices] = await Promise.all([loadHomeV2(), rest('/api/bridge/active-sessions'), rest('/api/bridge/devices')]);
  const key = (s) => `${s.deviceName}/${s.sessionId}:${s.status}`;
  const active = { v1: v1Active.sessions.map(key), v2: v2.active.sessions.map(key) };
  const devices = v1Devices.devices.map((d) => {
    const n = v2.devices.devices.find((x) => x.deviceName === d.deviceName) || {};
    return { device: d.deviceName, online: d.online, running: `${d.runningCount}/${n.runningCount}`,
      needsInput: `${d.needsInputCount}/${n.needsInputCount}`, projects: `${d.projectCount}/${n.projectCount}`,
      lastActive: `${d.lastActive} / ${n.lastActive}` };
  });
  console.log('[v2 compare] active identical:', active.v1.join() === active.v2.join(), active);
  console.table(devices);
  return { active, devices };
};
