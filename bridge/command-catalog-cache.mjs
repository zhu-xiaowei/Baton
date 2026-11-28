import crypto from 'crypto';

export const COMMAND_CATALOG_TTL_MS = 5 * 60_000;
export const COMMAND_DESCRIPTION_MAX_BYTES = 256;

function trimDescription(value) {
  if (typeof value !== 'string') return value;
  if (Buffer.byteLength(value) <= COMMAND_DESCRIPTION_MAX_BYTES) return value;
  let bytes = 0;
  let trimmed = '';
  for (const character of value) {
    const size = Buffer.byteLength(character);
    if (bytes + size > COMMAND_DESCRIPTION_MAX_BYTES) break;
    trimmed += character;
    bytes += size;
  }
  return trimmed;
}

function copyField(target, source, key) {
  const value = source?.[key];
  if (value === undefined || value === null || value === '') return;
  target[key] = value;
}

function normalizeOption(option) {
  if (!option || typeof option !== 'object') return null;
  const normalized = {};
  for (const key of ['name', 'label', 'value', 'behavior', 'confirm']) {
    copyField(normalized, option, key);
  }
  if (typeof option.description === 'string' && option.description) {
    normalized.description = trimDescription(option.description);
  }
  if (option.disabled === true) normalized.disabled = true;
  return normalized;
}

function normalizeCommand(command) {
  if (!command || typeof command.name !== 'string' || !command.name) return null;
  const normalized = { name: command.name };
  for (const key of ['argumentHint', 'behavior', 'picker', 'confirm']) {
    copyField(normalized, command, key);
  }
  if (typeof command.description === 'string' && command.description) {
    normalized.description = trimDescription(command.description);
  }
  if (command.optionsRemote === true) normalized.optionsRemote = true;
  if (command.disabled === true) normalized.disabled = true;
  if (Array.isArray(command.options) && command.options.length) {
    normalized.options = command.options.map(normalizeOption).filter(Boolean);
  }
  return normalized;
}

function normalizeSkill(skill) {
  if (!skill || typeof skill.name !== 'string' || !skill.name) return null;
  const normalized = { name: skill.name };
  if (typeof skill.description === 'string' && skill.description) {
    normalized.description = trimDescription(skill.description);
  }
  return normalized;
}

export function normalizeCommandCatalog(catalog) {
  return {
    commands: (Array.isArray(catalog?.commands) ? catalog.commands : [])
      .map(normalizeCommand)
      .filter(Boolean),
    skills: (Array.isArray(catalog?.skills) ? catalog.skills : [])
      .map(normalizeSkill)
      .filter(Boolean),
  };
}

function revisionFor(catalog) {
  return crypto.createHash('sha256')
    .update(JSON.stringify(catalog))
    .digest('hex')
    .slice(0, 24);
}

export function commandCatalogPayload(result, knownRevision = '') {
  if (!result) {
    return {
      revision: '',
      notModified: false,
      stale: false,
      error: 'Command catalog unavailable',
    };
  }
  const notModified = !!knownRevision && knownRevision === result.revision;
  return {
    revision: result.revision,
    notModified,
    stale: result.stale,
    error: result.error?.message || '',
    ...(!notModified ? result.catalog : {}),
  };
}

export class CommandCatalogCache {
  constructor(options = {}) {
    this.ttlMs = options.ttlMs ?? COMMAND_CATALOG_TTL_MS;
    this.now = options.now || Date.now;
    this.entries = new Map();
  }

  async get(key, loader, options = {}) {
    const current = this.entries.get(key);
    if (!options.forceRefresh
      && current?.value
      && this.now() - current.loadedAt < this.ttlMs) {
      return { ...current.value, stale: false, refreshed: false };
    }
    if (current?.pending) return current.pending;

    const previous = current?.value;
    const pending = (async () => {
      try {
        const catalog = normalizeCommandCatalog(await loader());
        const value = {
          catalog,
          revision: revisionFor(catalog),
        };
        this.entries.set(key, {
          value,
          loadedAt: this.now(),
          pending: null,
        });
        return { ...value, stale: false, refreshed: true };
      } catch (error) {
        if (!previous) {
          this.entries.delete(key);
          throw error;
        }
        this.entries.set(key, {
          value: previous,
          loadedAt: current.loadedAt,
          pending: null,
        });
        return {
          ...previous,
          stale: true,
          refreshed: false,
          error,
        };
      }
    })();

    this.entries.set(key, {
      value: previous,
      loadedAt: current?.loadedAt || 0,
      pending,
    });
    return pending;
  }

  invalidate(key) {
    if (key) this.entries.delete(key);
    else this.entries.clear();
  }
}
