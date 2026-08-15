import fs from 'fs';
import path from 'path';
import { resolveCodexHomes } from './runtime-capabilities.mjs';

// Captured from Codex 0.147.0's real command popup after scrolling through the
// complete list. This is the presentation order, not the first visible page.
export const CODEX_TUI_COMMANDS = Object.freeze([
  { name: 'model', description: 'choose what model and reasoning effort to use' },
  { name: 'ide', description: 'include current selection, open files, and other context from your IDE' },
  { name: 'permissions', description: 'choose what Codex is allowed to do' },
  { name: 'keymap', description: 'remap TUI shortcuts' },
  { name: 'vim', description: 'toggle Vim mode for the composer' },
  { name: 'experimental', description: 'toggle experimental features' },
  { name: 'approve', description: 'approve one retry of a recent auto-review denial' },
  { name: 'memories', description: 'configure memory use and generation' },
  {
    name: 'skills',
    description: 'use skills to improve how Codex performs specific tasks',
  },
  { name: 'import', description: 'import setup, this project, and recent chats from Claude Code' },
  { name: 'hooks', description: 'view and manage lifecycle hooks' },
  { name: 'review', description: 'review my current changes and find issues' },
  { name: 'rename', description: 'rename the current thread' },
  { name: 'new', description: 'start a new chat during a conversation' },
  { name: 'archive', description: 'archive this session and exit' },
  { name: 'delete', description: 'permanently delete this session and exit' },
  { name: 'resume', description: 'resume a saved chat' },
  { name: 'fork', description: 'fork the current chat' },
  { name: 'app', description: 'continue this session in the Desktop app' },
  { name: 'init', description: 'create an AGENTS.md file with instructions for Codex' },
  { name: 'compact', description: 'summarize conversation to prevent hitting the context limit' },
  { name: 'plan', description: 'switch to Plan mode' },
  { name: 'goal', description: 'set or view the goal for a long-running task' },
  { name: 'agent', description: 'switch the active agent thread' },
  { name: 'side', description: 'start a side conversation in an ephemeral fork' },
  { name: 'copy', description: 'copy last response as markdown' },
  { name: 'raw', description: 'toggle raw scrollback mode for copy-friendly terminal selection' },
  { name: 'diff', description: 'show git diff (including untracked files)' },
  { name: 'mention', description: 'mention a file' },
  { name: 'status', description: 'show current session configuration and token usage' },
  { name: 'title', description: 'configure which items appear in the terminal title' },
  { name: 'statusline', description: 'configure which items appear in the status line' },
  { name: 'theme', description: 'choose a syntax highlighting theme' },
  { name: 'pets', description: 'choose or hide the terminal pet' },
  { name: 'mcp', description: 'list configured MCP tools; use /mcp verbose for details' },
  { name: 'plugins', description: 'browse plugins' },
  { name: 'logout', description: 'log out of Codex' },
  { name: 'exit', description: 'exit Codex' },
  { name: 'feedback', description: 'send logs to maintainers' },
  { name: 'ps', description: 'list background terminals' },
  { name: 'stop', description: 'stop all background terminals' },
  { name: 'clear', description: 'clear the terminal and start a new chat' },
  { name: 'personality', description: 'choose a communication style for Codex' },
  { name: 'subagents', description: 'switch the active agent thread' },
]);

const MOBILE_COMMAND_BEHAVIOR = Object.freeze({
  model: { behavior: 'picker' },
  permissions: { behavior: 'picker' },
  experimental: { behavior: 'picker' },
  memories: { behavior: 'picker' },
  skills: { behavior: 'picker', picker: 'skills' },
  import: { behavior: 'picker' },
  hooks: { behavior: 'picker' },
  review: { behavior: 'send', inlineArgs: true },
  rename: { behavior: 'compose', inlineArgs: true, argumentHint: '<name>' },
  new: { behavior: 'client', clientAction: 'new', inlineArgs: true },
  archive: {
    behavior: 'confirm',
    confirm: 'Archive this session and leave it?',
  },
  delete: {
    behavior: 'confirm',
    confirm: 'Permanently delete this Codex session?',
  },
  resume: { behavior: 'client', clientAction: 'resume', inlineArgs: true },
  fork: { behavior: 'send', inlineArgs: true },
  app: { behavior: 'send' },
  init: { behavior: 'send' },
  compact: { behavior: 'send' },
  plan: { behavior: 'send', inlineArgs: true },
  goal: {
    behavior: 'compose',
    inlineArgs: true,
    argumentHint: '<objective|clear|pause|resume>',
  },
  agent: { behavior: 'picker' },
  copy: { behavior: 'client', clientAction: 'copy' },
  diff: { behavior: 'send' },
  mention: { behavior: 'client', clientAction: 'mention' },
  status: { behavior: 'send' },
  usage: { behavior: 'send', inlineArgs: true },
  mcp: { behavior: 'send', inlineArgs: true },
  logout: {
    behavior: 'confirm',
    confirm: 'Log out of Codex on this device?',
  },
  exit: { behavior: 'client', clientAction: 'exit' },
  feedback: { behavior: 'picker' },
  ps: { behavior: 'send' },
  stop: {
    behavior: 'confirm',
    confirm: 'Stop all background terminals for this thread?',
  },
  clear: { behavior: 'client', clientAction: 'clear', inlineArgs: true },
  personality: { behavior: 'picker' },
  subagents: { behavior: 'picker' },
});

export const CODEX_MOBILE_FILTERED_COMMANDS = Object.freeze({
  ide: 'requires live IDE context that the phone does not have',
  keymap: 'configures TUI keyboard shortcuts',
  vim: 'configures the TUI composer',
  approve: 'recent denial events only exist in TUI process memory',
  side: 'requires the TUI ephemeral side-conversation surface',
  raw: 'controls terminal scrollback rendering',
  title: 'controls terminal title rendering',
  statusline: 'controls terminal status-line rendering',
  theme: 'controls terminal syntax rendering',
  pets: 'controls terminal-only decoration',
  plugins: 'requires the interactive plugin browser and app authentication flow',
});

export const CODEX_MOBILE_COMMANDS = Object.freeze(
  CODEX_TUI_COMMANDS
    .filter((command) => MOBILE_COMMAND_BEHAVIOR[command.name])
    .map((command) => Object.freeze({
      ...command,
      ...MOBILE_COMMAND_BEHAVIOR[command.name],
    })),
);

const STATIC_COMMAND_OPTIONS = Object.freeze({
  import: [
    {
      name: 'claude-code',
      label: 'Claude Code',
      description: 'Import compatible setup and recent sessions from Claude Code.',
      value: 'claude-code',
      confirm: 'Import all compatible items detected from Claude Code?',
    },
    {
      name: 'cursor',
      label: 'Cursor',
      description: 'Import compatible setup and recent sessions from Cursor.',
      value: 'cursor',
      confirm: 'Import all compatible items detected from Cursor?',
    },
  ],
  permissions: [
    {
      name: 'ask',
      label: 'Ask for approvals',
      description: 'Use workspace access and ask before risky actions.',
      value: 'ask',
    },
    {
      name: 'auto-review',
      label: 'Approve for me',
      description: 'Use automatic review for approval requests.',
      value: 'auto-review',
    },
    {
      name: 'full-access',
      label: 'Full access',
      description: 'Run without sandbox restrictions or approval prompts.',
      value: 'full-access',
    },
  ],
  memories: [
    {
      name: 'enabled',
      label: 'Enable',
      description: 'Enable memories for this thread.',
      value: 'enabled',
    },
    {
      name: 'disabled',
      label: 'Disable',
      description: 'Disable memories for this thread.',
      value: 'disabled',
    },
    {
      name: 'reset',
      label: 'Reset memories',
      description: 'Delete generated memories and start over.',
      value: 'reset',
      confirm: 'Reset all generated Codex memories?',
    },
  ],
  personality: [
    {
      name: 'friendly',
      label: 'Friendly',
      description: 'Warm, collaborative, and helpful.',
      value: 'friendly',
    },
    {
      name: 'pragmatic',
      label: 'Pragmatic',
      description: 'Concise, task-focused, and direct.',
      value: 'pragmatic',
    },
  ],
  feedback: [
    {
      name: 'bug',
      label: 'Bug',
      description: 'Report a Codex client or runtime problem.',
      value: 'bug',
      behavior: 'compose',
    },
    {
      name: 'bad-result',
      label: 'Bad result',
      description: 'Report an incorrect or unhelpful result.',
      value: 'bad_result',
      behavior: 'compose',
    },
    {
      name: 'good-result',
      label: 'Good result',
      description: 'Share a successful result.',
      value: 'good_result',
      behavior: 'compose',
    },
    {
      name: 'safety-check',
      label: 'Safety check',
      description: 'Report a safety concern.',
      value: 'safety_check',
      behavior: 'compose',
    },
    {
      name: 'other',
      label: 'Other',
      description: 'Send other feedback.',
      value: 'other',
      behavior: 'compose',
    },
  ],
});

export const CODEX_INIT_PROMPT = `Generate a file named AGENTS.md that serves as a contributor guide for this repository.
Before writing, check whether AGENTS.md already exists in the current working directory. If it does, do not overwrite or modify it.
Your goal is to produce a clear, concise, and well-structured document with descriptive headings and actionable explanations for each section.
Follow the outline below, but adapt as needed - add sections if relevant, and omit those that do not apply to this project.

Document Requirements

- Title the document "Repository Guidelines".
- Use Markdown headings (#, ##, etc.) for structure.
- Keep the document concise. 200-400 words is optimal.
- Keep explanations short, direct, and specific to this repository.
- Provide examples where helpful (commands, directory paths, naming patterns).
- Maintain a professional, instructional tone.

Recommended Sections

Project Structure & Module Organization

- Outline the project structure, including where the source code, tests, and assets are located.

Build, Test, and Development Commands

- List key commands for building, testing, and running locally (e.g., npm test, make build).
- Briefly explain what each command does.

Coding Style & Naming Conventions

- Specify indentation rules, language-specific style preferences, and naming patterns.
- Include any formatting or linting tools used.

Testing Guidelines

- Identify testing frameworks and coverage requirements.
- State test naming conventions and how to run tests.

Commit & Pull Request Guidelines

- Summarize commit message conventions found in the project's Git history.
- Outline pull request requirements (descriptions, linked issues, screenshots, etc.).

(Optional) Add other sections if relevant, such as Security & Configuration Tips, Architecture Overview, or Agent-Specific Instructions.`;

function effectiveCodexHome(options = {}) {
  return (options.codexHomes || resolveCodexHomes(options.env))[0] || '';
}

function parseFrontmatter(content) {
  const firstLine = content.match(/^(.*?)(?:\r?\n|$)/)?.[1] || '';
  if (firstLine.trim() !== '---') {
    return { description: '', argumentHint: '', content };
  }
  const lines = content.split(/\r?\n/);
  let description = '';
  let argumentHint = '';
  let end = -1;
  for (let index = 1; index < lines.length; index++) {
    const trimmed = lines[index].trim();
    if (trimmed === '---') {
      end = index;
      break;
    }
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf(':');
    if (separator === -1) continue;
    const key = trimmed.slice(0, separator).trim().toLowerCase();
    let value = trimmed.slice(separator + 1).trim();
    if (value.length >= 2
      && ((value.startsWith('"') && value.endsWith('"'))
        || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    if (key === 'description') description = value;
    if (key === 'argument-hint' || key === 'argument_hint') argumentHint = value;
  }
  if (end === -1) return { description: '', argumentHint: '', content };
  return {
    description,
    argumentHint,
    content: lines.slice(end + 1).join('\n'),
  };
}

export function scanCodexLegacyPrompts(options = {}) {
  const home = effectiveCodexHome(options);
  if (!home) return [];
  const promptsDir = path.join(home, 'prompts');
  let entries;
  try {
    entries = fs.readdirSync(promptsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const prompts = [];
  for (const entry of entries) {
    if (!entry.name.toLowerCase().endsWith('.md')) continue;
    const promptPath = path.join(promptsDir, entry.name);
    let stat;
    let raw;
    try {
      stat = fs.statSync(promptPath);
      if (!stat.isFile()) continue;
      raw = fs.readFileSync(promptPath, 'utf8');
    } catch {
      continue;
    }
    const parsed = parseFrontmatter(raw);
    const promptName = path.basename(entry.name, path.extname(entry.name));
    prompts.push({
      name: promptName,
      commandName: `prompts:${promptName}`,
      description: parsed.description || 'run a saved Codex prompt',
      argumentHint: parsed.argumentHint,
      content: parsed.content,
      path: promptPath,
    });
  }
  prompts.sort((left, right) => left.name.localeCompare(right.name));
  return prompts;
}

export function codexCommandCatalog(options = {}) {
  const platform = options.platform || process.platform;
  const builtins = CODEX_MOBILE_COMMANDS
    .filter((command) => command.name !== 'app'
      || platform === 'darwin'
      || platform === 'win32')
    .map((command) => {
      const commandOptions = (
        options.commandOptions?.[command.name]
        || STATIC_COMMAND_OPTIONS[command.name]
        || []
      ).map((item) => ({ ...item }));
      return {
        ...command,
        ...(command.name === 'hooks' && commandOptions.length === 0
          ? { behavior: 'send' }
          : {}),
        options: commandOptions,
        source: 'builtin',
        runtime: 'codex',
      };
    });
  const prompts = scanCodexLegacyPrompts(options).map((prompt) => {
    const requiresArgs = !!prompt.argumentHint
      || namedArgumentNames(prompt.content).length > 0
      || /\$[1-9]|\$ARGUMENTS/.test(prompt.content);
    return {
      name: prompt.commandName,
      description: prompt.description,
      argumentHint: prompt.argumentHint,
      source: 'legacy-prompt',
      runtime: 'codex',
      behavior: requiresArgs ? 'compose' : 'send',
      inlineArgs: true,
    };
  });
  return builtins.concat(prompts);
}

function parseShellWords(text) {
  const words = [];
  let word = '';
  let quote = '';
  let escaped = false;
  let started = false;
  for (const character of text) {
    if (escaped) {
      word += character;
      escaped = false;
      started = true;
      continue;
    }
    if (character === '\\' && quote !== "'") {
      escaped = true;
      started = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = '';
      else word += character;
      started = true;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      started = true;
      continue;
    }
    if (/\s/.test(character)) {
      if (started) {
        words.push(word);
        word = '';
        started = false;
      }
      continue;
    }
    word += character;
    started = true;
  }
  if (escaped) word += '\\';
  if (quote) throw new Error('Unterminated quote in prompt arguments.');
  if (started) words.push(word);
  return words;
}

function namedArgumentNames(content) {
  const names = [];
  const seen = new Set();
  const pattern = /(^|[^$])\$([A-Z][A-Z0-9_]*)/g;
  let match;
  while ((match = pattern.exec(content)) !== null) {
    const name = match[2];
    if (name !== 'ARGUMENTS' && !seen.has(name)) {
      seen.add(name);
      names.push(name);
    }
  }
  return names;
}

function expandNamedPrompt(prompt, commandName, rest, names) {
  const values = new Map();
  for (const token of parseShellWords(rest)) {
    const separator = token.indexOf('=');
    if (separator === -1) {
      throw new Error(
        `Could not parse /${commandName}: expected key=value but found '${token}'. `
        + 'Wrap values in double quotes if they contain spaces.',
      );
    }
    if (separator === 0) {
      throw new Error(
        `Could not parse /${commandName}: expected a name before '=' in '${token}'.`,
      );
    }
    values.set(token.slice(0, separator), token.slice(separator + 1));
  }
  const missing = names.filter((name) => !values.has(name));
  if (missing.length) {
    throw new Error(
      `Missing required args for /${commandName}: ${missing.join(', ')}. `
      + 'Provide as key=value (quote values with spaces).',
    );
  }
  return prompt.content.replace(
    /(^|[^$])\$([A-Z][A-Z0-9_]*)/g,
    (whole, prefix, name) => (
      name === 'ARGUMENTS' ? whole : `${prefix}${values.get(name) ?? `$${name}`}`
    ),
  );
}

function expandPositionalPrompt(prompt, rest) {
  const args = parseShellWords(rest);
  let expanded = prompt.content.replace(/\$([1-9])/g, (_whole, index) => (
    args[Number(index) - 1] || ''
  ));
  expanded = expanded.replace(/\$ARGUMENTS/g, args.join(' '));
  return expanded;
}

export function expandCodexLegacyPrompt(text, options = {}) {
  const match = /^\/prompts:([^\s]+)(?:\s+([\s\S]*))?$/.exec(String(text || '').trim());
  if (!match) return null;
  const prompt = scanCodexLegacyPrompts(options)
    .find((candidate) => candidate.name === match[1]);
  if (!prompt) {
    throw new Error(`Unknown Codex prompt: /prompts:${match[1]}`);
  }
  const rest = match[2] || '';
  const names = namedArgumentNames(prompt.content);
  return names.length
    ? expandNamedPrompt(prompt, prompt.commandName, rest, names)
    : expandPositionalPrompt(prompt, rest);
}

export function parseCodexSlashCommand(text) {
  const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(String(text || '').trim());
  if (!match) return null;
  return {
    name: match[1],
    args: match[2] || '',
  };
}

export function isSupportedCodexCommand(name, options = {}) {
  const platform = options.platform || process.platform;
  return CODEX_MOBILE_COMMANDS.some((command) => (
    command.name === name
    && (name !== 'app' || platform === 'darwin' || platform === 'win32')
  ))
    || name.startsWith('prompts:');
}
