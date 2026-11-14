const q = value => "'" + String(value).replace(/'/g, "'\\''") + "'";
const icon = id => './assets/runtime-' + id + '.svg';
const plain = { agentToggle: false, slashPrompts: false };

const LIST = [
  { id: 'claude', label: 'Claude Code', short: 'Claude', icon: './assets/claude-code.svg', mono: false,
    resume: id => 'claude --resume ' + id, features: { agentToggle: true, slashPrompts: true } },
  { id: 'codex', label: 'Codex', short: 'Codex', icon: './assets/codex.svg', mono: true,
    resume: id => 'codex resume ' + id, features: { agentToggle: false, slashPrompts: true } },
  { id: 'opencode', label: 'OpenCode', short: 'OpenCode', icon: icon('opencode'), mono: true,
    resume: id => 'opencode -s ' + id, features: plain },
  { id: 'dsh', label: 'DeepSeek Harness', short: 'DSH', icon: icon('dsh'), mono: false,
    resume: (id, cwd) => cwd && 'cd ' + q(cwd) + ' && dsh headless --session-id ' + id + ' -', features: plain },
  { id: 'hermes', label: 'Hermes', short: 'Hermes', icon: icon('hermes'), mono: true,
    resume: id => 'hermes --resume ' + id, features: plain },
  { id: 'pi', label: 'Pi', short: 'Pi', icon: icon('pi'), mono: false,
    resume: (id, cwd) => cwd && 'cd ' + q(cwd) + ' && pi --session ' + id, features: plain },
  { id: 'kiro', label: 'Kiro', short: 'Kiro', icon: icon('kiro'), mono: false,
    resume: (id, cwd) => cwd && 'cd ' + q(cwd) + ' && kiro-cli --resume-id ' + id, features: plain },
];

export const RUNTIMES = Object.fromEntries(LIST.map(runtime => [runtime.id, runtime]));

// Storage IDs are `<runtime>:<native>`, except Claude's, which are unprefixed.
export function runtimeOf(sessionId, runtime) {
  var prefix = String(sessionId || '').split(':')[0];
  if (prefix !== 'claude' && RUNTIMES[prefix]) return prefix;
  return RUNTIMES[runtime] ? runtime : 'claude';
}

export function runtimeInfo(runtime) {
  return RUNTIMES[runtime] || RUNTIMES.claude;
}
