// Claude Code supplies the environment-specific command and model catalogs via
// its stream-json initialize control request. These sets only describe mobile
// behavior; they never supply user-facing catalog data.

const LOCAL_COMMAND_MATCHERS = new Map([
  ['__remote-workflow', () => true],
  ['agents', (command) => command.description?.startsWith('(removed)')],
  ['auto-mode-setup', (command) => command.argumentHint?.includes('--request-id')],
  ['autocompact', (command) => command.argumentHint?.startsWith('[auto|')],
  ['clear', (command) => command.aliases?.includes('reset')],
  ['color', (command) => command.argumentHint?.includes('|default]')],
  ['compact', (command) => command.argumentHint?.includes('custom summarization')],
  ['config', (command) => command.argumentHint === 'key=value'],
  ['context', (command) => command.description === 'Show current context usage'],
  ['effort', (command) => /^<[^>]*\|[^>]*>$/.test(command.argumentHint || '')],
  ['fast', (command) => command.argumentHint === '[on|off]'],
  ['heapdump', (command) => command.description?.includes('heap')],
  ['init', (command) => command.description?.startsWith('Initialize a new CLAUDE.md')],
  ['mcp', (command) => command.argumentHint?.startsWith('[reconnect|')],
  ['model', (command) => command.argumentHint === '<model>'],
  ['reload-skills', (command) => command.description?.startsWith('Pick up skills')],
  ['rename', (command) => command.aliases?.includes('name')],
  ['usage', (command) => command.aliases?.includes('cost')],
  ['workflow-launch-exec', () => true],
]);

const FILTERED_COMMAND_NAMES = new Set([
  '__remote-workflow',
  'agents',
  'auto-mode-setup',
  'clear',
  'color',
  'heapdump',
  'workflow-launch-exec',
]);

const CAPTURED_LOCAL_COMMAND_NAMES = new Set([
  'autocompact',
  'config',
  'context',
  'effort',
  'fast',
  'mcp',
  'model',
  'reload-skills',
  'rename',
  'usage',
]);

const COMPOSE_COMMAND_NAMES = new Set([
  'autocompact',
  'config',
  'rename',
]);

function compareNames(a, b) {
  return a.name.localeCompare(b.name);
}

function enumValues(argumentHint) {
  const hint = String(argumentHint || '').trim();
  const pairs = { '<': '>', '[': ']', '(': ')' };
  if (!pairs[hint[0]] || hint.at(-1) !== pairs[hint[0]]) return [];
  const body = hint.slice(1, -1);
  if (!body.includes('|')) return [];
  return body.split('|').map((value) => value.trim()).filter(Boolean);
}

function isRuntimeLocalCommand(command) {
  const matcher = LOCAL_COMMAND_MATCHERS.get(command.name);
  return !!matcher && !!matcher(command);
}

function commandBehavior(command, models, runtimeLocal) {
  if (runtimeLocal && command.name === 'model' && models.length) {
    return {
      behavior: 'picker',
      options: models.map((model) => ({
        name: model.value,
        label: model.displayName || model.value,
        description: model.description || '',
        value: model.value,
      })),
    };
  }
  if (runtimeLocal && (command.name === 'effort' || command.name === 'fast')) {
    const values = enumValues(command.argumentHint);
    if (values.length) {
      return {
        behavior: 'picker',
        options: values.map((value) => ({
          name: value,
          label: value,
          value,
        })),
      };
    }
  }
  if (COMPOSE_COMMAND_NAMES.has(command.name)) return { behavior: 'compose' };
  if (!runtimeLocal && command.argumentHint) {
    return { behavior: 'compose' };
  }
  return { behavior: 'send' };
}

export function claudeCommandCatalog(context = {}) {
  const commands = Array.isArray(context.commands) ? context.commands : [];
  const models = Array.isArray(context.models) ? context.models : [];
  const local = [];
  const prompts = [];
  const seen = new Set();

  for (const raw of commands) {
    const name = typeof raw?.name === 'string' ? raw.name.trim() : '';
    if (!name || seen.has(name)) continue;
    const normalized = {
      ...raw,
      name,
      description: typeof raw.description === 'string' ? raw.description : '',
      argumentHint: typeof raw.argumentHint === 'string' ? raw.argumentHint : '',
      aliases: Array.isArray(raw.aliases) ? raw.aliases.slice() : [],
    };
    const runtimeLocal = isRuntimeLocalCommand(normalized);
    if (runtimeLocal && FILTERED_COMMAND_NAMES.has(name)) continue;
    if (runtimeLocal && name === 'fast' && context.fast_mode_disabled_reason) continue;
    seen.add(name);
    const item = {
      name,
      source: runtimeLocal ? 'builtin' : 'runtime',
      description: normalized.description,
      argumentHint: normalized.argumentHint,
      aliases: normalized.aliases,
      ...commandBehavior(normalized, models, runtimeLocal),
    };
    (runtimeLocal ? local : prompts).push(item);
  }

  local.sort(compareNames);
  prompts.sort(compareNames);
  return local.concat(prompts);
}

export function parseClaudeSlashCommand(text) {
  const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(String(text || '').trim());
  if (!match) return null;
  return {
    name: match[1],
    args: (match[2] || '').trim(),
    text: '/' + match[1] + (match[2] ? ' ' + match[2].trim() : ''),
  };
}

export function capturedClaudeCommandNames(context = {}) {
  const commands = Array.isArray(context.commands) ? context.commands : [];
  return new Set(commands
    .filter((command) => isRuntimeLocalCommand(command)
      && CAPTURED_LOCAL_COMMAND_NAMES.has(command.name))
    .map((command) => command.name));
}
