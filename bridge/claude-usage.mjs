import fs from 'fs';
import path from 'path';
import { Worker } from 'worker_threads';
import { CLAUDE_PROJECTS } from './config.mjs';
import { scanJsonlLines } from './jsonl.mjs';
import { getSessionMetadata } from './session.mjs';

const SENSITIVE_KEY = /(api.?key|token|secret|password|credential|authorization|bearer|cookie)/i;
const CONFIG_ENTRY_LIMIT = 60;
const CONFIG_SOURCE_LIMIT = 10;
const TEXT_LIMIT = 240;
const STATS_CACHE_MS = 60_000;
const MAX_PANEL_BYTES = 23_000;

let statsCache = null;
let statsPending = null;

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function dateKey(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function dateFromKey(key) {
  const [year, month, day] = String(key).split('-').map(Number);
  return new Date(year, month - 1, day);
}

function addDays(date, amount) {
  const result = new Date(date);
  result.setDate(result.getDate() + amount);
  return result;
}

function daysBetween(startKey, endKey) {
  if (!startKey || !endKey) return 0;
  return Math.floor((dateFromKey(endKey) - dateFromKey(startKey)) / 86_400_000);
}

function tokenUsage(usage = {}) {
  const input = number(usage.input_tokens ?? usage.inputTokens);
  const output = number(usage.output_tokens ?? usage.outputTokens);
  const cacheCreation = number(
    usage.cache_creation_input_tokens ?? usage.cacheCreationInputTokens,
  );
  const cacheRead = number(usage.cache_read_input_tokens ?? usage.cacheReadInputTokens);
  return {
    input,
    output,
    cacheCreation,
    cacheRead,
    total: input + output + cacheCreation + cacheRead,
  };
}

function emptyMetric() {
  return {
    input: 0,
    output: 0,
    cacheCreation: 0,
    cacheRead: 0,
    total: 0,
  };
}

function addMetric(target, source) {
  target.input += source.input;
  target.output += source.output;
  target.cacheCreation += source.cacheCreation;
  target.cacheRead += source.cacheRead;
  target.total += source.total;
}

function ensureDay(days, key) {
  let day = days.get(key);
  if (!day) {
    day = {
      date: key,
      sessions: new Set(),
      metrics: emptyMetric(),
      models: new Map(),
    };
    days.set(key, day);
  }
  return day;
}

function ensureModel(models, id) {
  let model = models.get(id);
  if (!model) {
    model = { id, ...emptyMetric(), messages: 0 };
    models.set(id, model);
  }
  return model;
}

function readSession(filePath, aggregate, fallbackSessionId) {
  const localSeen = new Set();
  let sessionId = fallbackSessionId;
  let start = '';
  let end = '';
  let version = '';
  let cwd = '';
  let entrypoint = '';
  let sessionKind = '';
  let model = '';
  let hasActivity = false;

  try {
    scanJsonlLines(filePath, (line) => {
      if (!line.trim()) return;
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        aggregate.malformedLines++;
        return;
      }
      if (row.isSidechain) return;
      sessionId = row.sessionId || sessionId;
      const timestamp = row.timestamp || row.snapshot?.timestamp || '';
      const key = dateKey(timestamp);
      if (key) {
        hasActivity = true;
        if (!start || timestamp < start) start = timestamp;
        if (!end || timestamp > end) end = timestamp;
        ensureDay(aggregate.days, key).sessions.add(sessionId);
      }
      version = row.version || version;
      cwd = row.cwd || cwd;
      entrypoint = row.entrypoint || entrypoint;
      sessionKind = row.sessionKind || sessionKind;
      if (row.type !== 'assistant' || !row.message?.usage || !key) return;

      const dedupKey = row.uuid || row.message.id || `${filePath}:${timestamp}`;
      if (localSeen.has(dedupKey) || aggregate.seenMessages.has(dedupKey)) return;
      localSeen.add(dedupKey);
      aggregate.seenMessages.add(dedupKey);

      model = row.message.model || model || 'unknown';
      const usage = tokenUsage(row.message.usage);
      const day = ensureDay(aggregate.days, key);
      addMetric(day.metrics, usage);
      const dayModel = ensureModel(day.models, model);
      addMetric(dayModel, usage);
      dayModel.messages++;
    });
  } catch (error) {
    aggregate.errors.push({ path: filePath, error: error.message });
    return;
  }

  if (!hasActivity) return;
  const previous = aggregate.sessions.get(sessionId);
  if (!previous) {
    aggregate.sessions.set(sessionId, {
      id: sessionId,
      start,
      end,
      version,
      cwd,
      entrypoint,
      sessionKind,
      model,
      filePath,
    });
    return;
  }
  if (start && (!previous.start || start < previous.start)) previous.start = start;
  if (end && (!previous.end || end > previous.end)) previous.end = end;
  previous.version = version || previous.version;
  previous.cwd = cwd || previous.cwd;
  previous.entrypoint = entrypoint || previous.entrypoint;
  previous.sessionKind = sessionKind || previous.sessionKind;
  previous.model = model || previous.model;
}

function listTranscriptFiles(projectsRoot) {
  const files = [];
  let projects = [];
  try {
    projects = fs.readdirSync(projectsRoot, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const projectDir = path.join(projectsRoot, project.name);
    let entries = [];
    try {
      entries = fs.readdirSync(projectDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl') || entry.name.startsWith('.')) {
        continue;
      }
      files.push(path.join(projectDir, entry.name));
    }
  }
  return files;
}

function streaks(activeKeys, todayKey) {
  const active = new Set(activeKeys);
  const sorted = [...active].sort();
  let longest = 0;
  let run = 0;
  let previous = '';
  for (const key of sorted) {
    run = previous && daysBetween(previous, key) === 1 ? run + 1 : 1;
    if (run > longest) longest = run;
    previous = key;
  }

  let cursor = todayKey;
  if (!active.has(cursor)) {
    const yesterday = dateKey(addDays(dateFromKey(todayKey), -1));
    if (!active.has(yesterday)) return { longest, current: 0 };
    cursor = yesterday;
  }
  let current = 0;
  while (active.has(cursor)) {
    current++;
    cursor = dateKey(addDays(dateFromKey(cursor), -1));
  }
  return { longest, current };
}

function rangeResult(aggregate, key, label, startKey, todayKey) {
  const dayValues = [...aggregate.days.values()]
    .filter((day) => !startKey || day.date >= startKey)
    .sort((a, b) => a.date.localeCompare(b.date));
  const metrics = emptyMetric();
  const sessionIds = new Set();
  const models = new Map();
  for (const day of dayValues) {
    addMetric(metrics, day.metrics);
    for (const sessionId of day.sessions) sessionIds.add(sessionId);
    for (const [modelId, source] of day.models) {
      const target = ensureModel(models, modelId);
      addMetric(target, source);
      target.messages += source.messages;
    }
  }

  const activeKeys = dayValues.filter((day) => day.sessions.size > 0).map((day) => day.date);
  const streak = streaks(activeKeys, todayKey);
  const earliest = activeKeys[0] || todayKey;
  let longestSessionMs = 0;
  for (const sessionId of sessionIds) {
    const session = aggregate.sessions.get(sessionId);
    if (!session?.start || !session?.end) continue;
    longestSessionMs = Math.max(longestSessionMs, new Date(session.end) - new Date(session.start));
  }
  const mostActive = dayValues.reduce((best, day) => {
    if (!best) return day;
    if (day.metrics.total !== best.metrics.total) {
      return day.metrics.total > best.metrics.total ? day : best;
    }
    return day.sessions.size > best.sessions.size ? day : best;
  }, null);
  const displayedDays = key === 'all' ? dayValues.slice(-365) : dayValues;

  return {
    key,
    label,
    summary: {
      totalTokens: metrics.total,
      sessions: sessionIds.size,
      activeDays: activeKeys.length,
      periodDays: startKey ? daysBetween(startKey, todayKey) + 1 : daysBetween(earliest, todayKey) + 1,
      mostActiveDay: mostActive?.date || '',
      longestSessionMs,
      longestStreak: streak.longest,
      currentStreak: streak.current,
    },
    tokenBreakdown: metrics,
    days: displayedDays.map((day) => ({
      date: day.date,
      tokens: day.metrics.total,
      sessions: day.sessions.size,
    })),
    models: [...models.values()]
      .sort((a, b) => b.total - a.total || a.id.localeCompare(b.id)),
  };
}

export function scanClaudeStats(options = {}) {
  const projectsRoot = options.projectsRoot || CLAUDE_PROJECTS;
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  if (options.useCache !== false
    && statsCache
    && statsCache.projectsRoot === projectsRoot
    && Date.now() - statsCache.at < STATS_CACHE_MS) {
    return statsCache.value;
  }

  const aggregate = {
    sessions: new Map(),
    days: new Map(),
    seenMessages: new Set(),
    malformedLines: 0,
    errors: [],
  };
  const files = listTranscriptFiles(projectsRoot);
  for (const filePath of files) {
    readSession(filePath, aggregate, path.basename(filePath, '.jsonl'));
  }

  const todayKey = dateKey(now);
  const last7 = dateKey(addDays(now, -6));
  const last30 = dateKey(addDays(now, -29));
  const value = {
    today: todayKey,
    filesScanned: files.length,
    malformedLines: aggregate.malformedLines,
    errors: aggregate.errors.slice(0, 10),
    ranges: [
      rangeResult(aggregate, 'all', 'All time', '', todayKey),
      rangeResult(aggregate, '7d', 'Last 7 days', last7, todayKey),
      rangeResult(aggregate, '30d', 'Last 30 days', last30, todayKey),
    ],
  };
  if (options.useCache !== false) {
    statsCache = { projectsRoot, at: Date.now(), value };
  }
  return value;
}

function scanClaudeStatsInWorker(options = {}) {
  const projectsRoot = options.projectsRoot || CLAUDE_PROJECTS;
  if (statsCache
    && statsCache.projectsRoot === projectsRoot
    && Date.now() - statsCache.at < STATS_CACHE_MS) {
    return Promise.resolve(statsCache.value);
  }
  if (statsPending?.projectsRoot === projectsRoot) return statsPending.promise;

  const promise = new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./claude-stats-worker.mjs', import.meta.url), {
      execArgv: process.execArgv.filter((arg) => !arg.startsWith('--input-type')),
      workerData: {
        projectsRoot,
        now: options.now instanceof Date ? options.now.toISOString() : options.now,
      },
    });
    worker.once('message', (message) => {
      if (message?.ok) resolve(message.value);
      else reject(new Error(message?.error || 'Claude stats scan failed.'));
    });
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (code !== 0) reject(new Error(`Claude stats worker exited with code ${code}.`));
    });
  }).then((value) => {
    statsCache = { projectsRoot, at: Date.now(), value };
    return value;
  }).finally(() => {
    if (statsPending?.promise === promise) statsPending = null;
  });
  statsPending = { projectsRoot, promise };
  return promise;
}

function sessionSnapshot(filePath, sessionId) {
  const result = {
    sessionId,
    name: '',
    version: '',
    cwd: '',
    entrypoint: '',
    sessionKind: '',
    model: '',
    metrics: emptyMetric(),
  };
  if (!filePath || !fs.existsSync(filePath)) return result;
  const metadata = getSessionMetadata(filePath);
  result.name = metadata.preview || '';
  const seen = new Set();
  try {
    scanJsonlLines(filePath, (line) => {
      if (!line.trim()) return;
      try {
        const row = JSON.parse(line);
        result.version = row.version || result.version;
        result.cwd = row.cwd || result.cwd;
        result.entrypoint = row.entrypoint || result.entrypoint;
        result.sessionKind = row.sessionKind || result.sessionKind;
        if (row.type === 'assistant' && row.message?.model) result.model = row.message.model;
        if (row.type === 'assistant' && row.message?.usage) {
          const key = row.uuid || row.message.id;
          if (!key || !seen.has(key)) {
            if (key) seen.add(key);
            addMetric(result.metrics, tokenUsage(row.message.usage));
          }
        }
      } catch {}
    });
  } catch {}
  return result;
}

function sanitizeValue(key, value, depth = 0) {
  if (SENSITIVE_KEY.test(key)) return '••••';
  if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') {
    return value.length > TEXT_LIMIT ? `${value.slice(0, TEXT_LIMIT)}…` : value;
  }
  if (depth >= 3) return Array.isArray(value) ? `[${value.length} items]` : '{…}';
  if (Array.isArray(value)) {
    return value.slice(0, 10).map((item) => sanitizeValue(key, item, depth + 1));
  }
  const output = {};
  for (const [childKey, childValue] of Object.entries(value).slice(0, CONFIG_ENTRY_LIMIT)) {
    if (key === 'env') output[childKey] = '(set)';
    else output[childKey] = sanitizeValue(childKey, childValue, depth + 1);
  }
  return output;
}

function configEntries(value) {
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value)
    .slice(0, CONFIG_ENTRY_LIMIT)
    .map(([key, raw]) => ({ key, value: sanitizeValue(key, raw) }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

function modelLabels(initialize) {
  const labels = new Map();
  for (const model of initialize?.models || []) {
    const label = model.displayName || model.value || model.resolvedModel;
    if (model.value) labels.set(model.value, label);
    if (model.resolvedModel) labels.set(model.resolvedModel, label);
  }
  return labels;
}

function applyModelLabels(stats, labels) {
  for (const range of stats.ranges) {
    for (const model of range.models) model.label = labels.get(model.id) || model.id;
  }
}

function formatText(panel) {
  const lines = ['Claude Code settings'];
  lines.push('', '[Status]');
  for (const item of panel.status.items) lines.push(`${item.label}: ${item.value || '—'}`);
  lines.push('', '[Config]');
  for (const item of panel.config.applied) lines.push(`${item.key}: ${JSON.stringify(item.value)}`);
  for (const item of panel.config.effective) lines.push(`${item.key}: ${JSON.stringify(item.value)}`);
  lines.push('', '[Usage]');
  for (const item of panel.usage.items) lines.push(`${item.label}: ${item.value}`);
  const all = panel.stats.ranges[0];
  lines.push('', '[Stats · Overview]');
  lines.push(`Total tokens: ${all.summary.totalTokens}`);
  lines.push(`Sessions: ${all.summary.sessions}`);
  lines.push(`Active days: ${all.summary.activeDays}/${all.summary.periodDays}`);
  lines.push(`Most active day: ${all.summary.mostActiveDay || '—'}`);
  lines.push(`Longest session (ms): ${all.summary.longestSessionMs}`);
  lines.push(`Longest streak: ${all.summary.longestStreak}`);
  lines.push(`Current streak: ${all.summary.currentStreak}`);
  lines.push('', '[Stats · Models]');
  for (const model of all.models) lines.push(`${model.label}: ${model.total} tokens`);
  const text = lines.join('\n');
  return text.length > 6_000 ? `${text.slice(0, 5_999)}…` : text;
}

function usageItems(usage, transcriptMetrics) {
  const session = usage?.session || {};
  const aggregate = Object.values(session.model_usage || session.modelUsage || {})
    .reduce((total, item) => {
      addMetric(total, tokenUsage(item));
      return total;
    }, emptyMetric());
  if (!aggregate.total && transcriptMetrics?.total) addMetric(aggregate, transcriptMetrics);
  return [
    { label: 'Total cost', value: `$${number(session.total_cost_usd).toFixed(4)}` },
    { label: 'API duration', value: number(session.total_api_duration_ms), format: 'duration' },
    { label: 'Wall duration', value: number(session.total_duration_ms), format: 'duration' },
    { label: 'Lines added', value: number(session.total_lines_added), format: 'number' },
    { label: 'Lines removed', value: number(session.total_lines_removed), format: 'number' },
    { label: 'Input tokens', value: aggregate.input, format: 'number' },
    { label: 'Output tokens', value: aggregate.output, format: 'number' },
    { label: 'Cache creation', value: aggregate.cacheCreation, format: 'number' },
    { label: 'Cache read', value: aggregate.cacheRead, format: 'number' },
  ];
}

function panelBytes(panel) {
  return Buffer.byteLength(JSON.stringify(panel));
}

function fitPanelForTransport(panel) {
  if (panelBytes(panel) <= MAX_PANEL_BYTES) return panel;
  panel.truncated = true;
  panel.config.sources = panel.config.sources.slice(0, 5).map((source) => ({
    ...source,
    entries: source.entries.slice(0, 20),
  }));
  if (panelBytes(panel) <= MAX_PANEL_BYTES) return panel;
  panel.config.sources = [];
  for (const range of panel.stats.ranges) {
    range.models = range.models.slice(0, 20);
    if (range.key === 'all') range.days = range.days.slice(-180);
  }
  if (panelBytes(panel) <= MAX_PANEL_BYTES) return panel;
  panel.config.applied = panel.config.applied.slice(0, 30);
  panel.config.effective = panel.config.effective.slice(0, 30);
  panel.usage.rateLimits = null;
  panel.usage.behaviors = null;
  for (const range of panel.stats.ranges) {
    range.models = range.models.slice(0, 10);
    if (range.key === 'all') range.days = range.days.slice(-90);
  }
  if (panelBytes(panel) <= MAX_PANEL_BYTES) return panel;
  panel.config.applied = panel.config.applied.slice(0, 15);
  panel.config.effective = panel.config.effective.slice(0, 15);
  for (const range of panel.stats.ranges) {
    range.models = range.models.slice(0, 5);
    if (range.key === 'all') range.days = range.days.slice(-30);
  }
  if (panelBytes(panel) <= MAX_PANEL_BYTES) return panel;
  panel.config.applied = [];
  panel.config.effective = [];
  for (const range of panel.stats.ranges) {
    range.models = [];
    range.days = [];
  }
  return panel;
}

export async function buildClaudeUsagePanel(options) {
  const {
    pool,
    sessionId,
    cwd,
    filePath,
    initialTab = 'usage',
    projectsRoot = CLAUDE_PROJECTS,
  } = options;
  const statsPromise = scanClaudeStatsInWorker({ projectsRoot });
  const [controls, stats] = await Promise.all([
    pool.inspectSession(
      sessionId,
      cwd,
      ['initialize', 'get_settings', 'get_usage'],
    ),
    statsPromise,
  ]);
  let initialize = controls.result.initialize || {};
  if (!initialize.commands) {
    try {
      initialize = await pool.inspect(cwd);
    } catch {}
  }
  const settings = controls.result.get_settings || {};
  const usage = controls.result.get_usage || {};
  const snapshot = sessionSnapshot(filePath, sessionId);
  const labels = modelLabels(initialize);
  const selectedModel = settings.applied?.model || snapshot.model || '';
  applyModelLabels(stats, labels);

  const sourceNames = (settings.sources || []).map((source) => source.source).filter(Boolean);
  const provider = initialize.account?.apiProvider || '';
  const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || '';
  const panel = {
    type: 'claude-usage',
    initialTab,
    status: {
      items: [
        { label: 'Version', value: snapshot.version },
        { label: 'Session name', value: snapshot.name },
        { label: 'Session ID', value: sessionId },
        { label: 'Session kind', value: snapshot.sessionKind || snapshot.entrypoint || 'interactive' },
        { label: 'Working directory', value: snapshot.cwd || cwd },
        { label: 'API connectivity', value: initialize.pid ? 'Connected' : 'Unavailable' },
        { label: 'API provider', value: provider },
        ...(region ? [{ label: 'Region', value: region }] : []),
        { label: 'Runtime PID', value: initialize.pid || '' },
        { label: 'Available models', value: (initialize.models || []).length },
        { label: 'Available agents', value: (initialize.agents || []).length },
        { label: 'Model', value: labels.get(selectedModel) || selectedModel },
        { label: 'Permission mode', value: initialize.current_permission_mode || '' },
        { label: 'Effort', value: settings.applied?.effort || '' },
        { label: 'Fast mode', value: initialize.fast_mode_state || '' },
        { label: 'Output style', value: initialize.output_style || '' },
        { label: 'Setting sources', value: sourceNames.join(', ') },
      ],
      diagnostics: Object.entries(controls.errors).map(([source, error]) => ({ source, error })),
    },
    config: {
      applied: configEntries(settings.applied),
      effective: configEntries(settings.effective),
      sources: (settings.sources || []).slice(0, CONFIG_SOURCE_LIMIT).map((source) => ({
        source: source.source || 'unknown',
        entries: configEntries(source.settings),
      })),
    },
    usage: {
      items: usageItems(usage, snapshot.metrics),
      subscriptionType: usage.subscription_type || '',
      rateLimitsAvailable: !!usage.rate_limits_available,
      rateLimits: sanitizeValue('rateLimits', usage.rate_limits),
      behaviors: sanitizeValue('behaviors', usage.behaviors),
    },
    stats,
  };
  fitPanelForTransport(panel);
  panel.rawText = formatText(panel);
  return panel;
}
