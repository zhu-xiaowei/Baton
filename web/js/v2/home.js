// Home: device names/online from /devices (server), everything else from each Bridge.
// Produces the shapes the home page renders (former /active-sessions and /devices).
import { state } from '../state.js';
import { showToast } from '../components/toast.js';
import { cachedOnlineDevices, connect, request, updateRoutes } from './direct-transport.js';

const CACHE_KEY = 'apeek_v2_home_devices';
const PROJECT_LIMIT = 15;
let inflight = null;

function readJson(key) {
  try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; }
}

// The server is reached through its CloudFront domain, which also serves /data.
function dataUrl() {
  return 'wss://' + new URL(state.SERVER).host + '/data';
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
  connect(dataUrl());
  cachedOnlineDevices().forEach(ask);
  const devicesResponse = await rest('/api/bridge/devices');
  window.__v2Timings.devices = Math.round(performance.now() - started);
  if (devicesResponse.protocol !== 2) {
    showToast('This server is too old for this app. Update it by running server/install.sh again.');
    throw new Error('server_outdated');
  }
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
    return { deviceName: device.deviceName, deviceDisplayName: device.deviceDisplayName, os: device.os,
      online: device.online, ...(answer ? answer.device : {}) };
  });
  devices.sort((a, b) => ((a.lastActive || '') < (b.lastActive || '') ? 1 : (a.lastActive || '') > (b.lastActive || '') ? -1 : 0));
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
