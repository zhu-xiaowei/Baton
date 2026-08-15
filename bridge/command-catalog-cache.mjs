import crypto from 'crypto';

export const COMMAND_CATALOG_TTL_MS = 5 * 60_000;

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

  async get(key, loader) {
    const current = this.entries.get(key);
    if (current?.value && this.now() - current.loadedAt < this.ttlMs) {
      return { ...current.value, stale: false, refreshed: false };
    }
    if (current?.pending) return current.pending;

    const previous = current?.value;
    const pending = (async () => {
      try {
        const catalog = await loader();
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
