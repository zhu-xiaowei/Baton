import assert from 'node:assert/strict';
import test from 'node:test';
import {
  COMMAND_DESCRIPTION_MAX_BYTES,
  CommandCatalogCache,
  commandCatalogPayload,
  commandCatalogReadyPayload,
  normalizeCommandCatalog,
} from '../../bridge/command-catalog-cache.mjs';

function catalog(name = 'model') {
  return {
    commands: [{ name, description: `${name} command` }],
    skills: [{ name: 'reviewer', description: 'Review changes' }],
  };
}

test('command catalog cache reuses fresh content without calling the loader', async () => {
  let now = 1_000;
  let loads = 0;
  const cache = new CommandCatalogCache({ ttlMs: 300_000, now: () => now });
  const first = await cache.get('claude:/project', async () => {
    loads++;
    return catalog();
  });
  now += 299_999;
  const second = await cache.get('claude:/project', async () => {
    loads++;
    return catalog('usage');
  });

  assert.equal(loads, 1);
  assert.equal(first.revision, second.revision);
  assert.equal(second.refreshed, false);
  assert.deepEqual(second.catalog, catalog());
});

test('command catalog revision changes only when normalized content changes', async () => {
  let now = 1_000;
  let next = catalog();
  const cache = new CommandCatalogCache({ ttlMs: 100, now: () => now });
  const first = await cache.get('claude:/project', async () => next);

  now += 101;
  const unchanged = await cache.get('claude:/project', async () => catalog());
  assert.equal(unchanged.refreshed, true);
  assert.equal(unchanged.revision, first.revision);

  now += 101;
  next = catalog('usage');
  const changed = await cache.get('claude:/project', async () => next);
  assert.notEqual(changed.revision, first.revision);
  assert.deepEqual(changed.catalog, next);
});

test('command catalog cache coalesces concurrent refreshes', async () => {
  let loads = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const cache = new CommandCatalogCache();
  const loader = async () => {
    loads++;
    await gate;
    return catalog();
  };
  const first = cache.get('codex:/project', loader);
  const second = cache.get('codex:/project', loader);
  release();

  const [left, right] = await Promise.all([first, second]);
  assert.equal(loads, 1);
  assert.equal(left.revision, right.revision);
  assert.deepEqual(left.catalog, right.catalog);
});

test('command catalog cache serves stale content when refresh fails', async () => {
  let now = 1_000;
  const cache = new CommandCatalogCache({ ttlMs: 100, now: () => now });
  const first = await cache.get('claude:/project', async () => catalog());
  now += 101;
  const stale = await cache.get('claude:/project', async () => {
    throw new Error('runtime unavailable');
  });

  assert.equal(stale.stale, true);
  assert.equal(stale.refreshed, false);
  assert.equal(stale.revision, first.revision);
  assert.deepEqual(stale.catalog, first.catalog);
  assert.match(stale.error.message, /runtime unavailable/);
});

test('command catalog cache does not invent content when the first load fails', async () => {
  const cache = new CommandCatalogCache();
  await assert.rejects(
    cache.get('claude:/missing', async () => {
      throw new Error('not available');
    }),
    /not available/,
  );
});

test('command catalog cache isolates runtime and project keys', async () => {
  let loads = 0;
  const cache = new CommandCatalogCache();
  await cache.get('claude:/one', async () => { loads++; return catalog('one'); });
  await cache.get('claude:/two', async () => { loads++; return catalog('two'); });
  await cache.get('codex:/one', async () => { loads++; return catalog('codex'); });
  await cache.get('claude:/one', async () => { loads++; return catalog('ignored'); });
  assert.equal(loads, 3);
});

test('command catalog payload omits content only when the caller revision matches', () => {
  const result = {
    catalog: catalog(),
    revision: 'revision-1',
    stale: false,
    refreshed: false,
  };
  assert.deepEqual(commandCatalogPayload(result, 'revision-1'), {
    revision: 'revision-1',
    notModified: true,
    stale: false,
    error: '',
  });
  assert.deepEqual(commandCatalogPayload(result, 'revision-old'), {
    revision: 'revision-1',
    notModified: false,
    stale: false,
    error: '',
    ...catalog(),
  });
  assert.deepEqual(commandCatalogPayload(result), {
    revision: 'revision-1',
    notModified: false,
    stale: false,
    error: '',
    ...catalog(),
  });
});

test('command catalog payload reports stale fallback and unavailable first load', () => {
  const stale = commandCatalogPayload({
    catalog: catalog(),
    revision: 'revision-1',
    stale: true,
    refreshed: false,
    error: new Error('runtime unavailable'),
  }, 'revision-1');
  assert.deepEqual(stale, {
    revision: 'revision-1',
    notModified: true,
    stale: true,
    error: 'runtime unavailable',
  });
  assert.deepEqual(commandCatalogPayload(null, 'revision-1'), {
    revision: '',
    notModified: false,
    stale: false,
    error: 'Command catalog unavailable',
  });
});

test('command catalog descriptions are capped before revision and delivery', () => {
  const long = '界'.repeat(COMMAND_DESCRIPTION_MAX_BYTES);
  const normalized = normalizeCommandCatalog({
    commands: [{
      name: 'model',
      description: long,
      options: [{ name: 'opus', description: long }],
    }],
    skills: [{ name: 'reviewer', description: long }],
  });

  assert.equal(Buffer.byteLength(normalized.commands[0].description), 255);
  assert.equal(normalized.commands[0].description, '界'.repeat(85));
  assert.equal(Buffer.byteLength(normalized.commands[0].options[0].description), 255);
  assert.equal(Buffer.byteLength(normalized.skills[0].description), 255);
  assert.equal(
    normalizeCommandCatalog({
      commands: [{ name: 'ascii', description: 'x'.repeat(300) }],
    }).commands[0].description,
    'x'.repeat(256),
  );
});

test('command catalog drops fields the frontend cannot display or execute', () => {
  const normalized = normalizeCommandCatalog({
    commands: [{
      name: 'model',
      description: 'Choose a model',
      source: 'builtin',
      aliases: ['models'],
      runtime: 'codex',
      inlineArgs: true,
      behavior: 'picker',
      options: [{
        name: 'opus',
        label: 'Opus',
        value: 'opus',
        description: 'Most capable',
        source: 'runtime',
      }],
    }],
    skills: [{
      name: 'reviewer',
      description: 'Review changes',
      path: '/private/skill/path',
      scope: 'user',
    }],
  });

  assert.deepEqual(normalized, {
    commands: [{
      name: 'model',
      description: 'Choose a model',
      behavior: 'picker',
      options: [{
        name: 'opus',
        label: 'Opus',
        value: 'opus',
        description: 'Most capable',
      }],
    }],
    skills: [{ name: 'reviewer', description: 'Review changes' }],
  });
});

test('ten thousand 256-byte commands stay within the REST catalog budget', () => {
  const normalized = normalizeCommandCatalog({
    commands: Array.from({ length: 10_000 }, (_, index) => ({
      name: `command-${index}`,
      description: 'x'.repeat(300),
      source: 'runtime',
      aliases: ['unused-alias'],
      runtime: 'claude',
      inlineArgs: true,
    })),
    skills: [],
  });
  const bytes = Buffer.byteLength(JSON.stringify(normalized));

  assert.equal(normalized.commands.length, 10_000);
  assert.equal(Buffer.byteLength(normalized.commands[0].description), 256);
  assert.ok(bytes < 3 * 1024 * 1024, `catalog was ${bytes} bytes`);
});

test('forced command catalog refresh bypasses a fresh bridge cache entry', async () => {
  let loads = 0;
  const cache = new CommandCatalogCache();
  const loader = async () => catalog(`model-${++loads}`);
  const first = await cache.get('claude:/project', loader);
  const refreshed = await cache.get(
    'claude:/project',
    loader,
    { forceRefresh: true },
  );

  assert.equal(loads, 2);
  assert.notEqual(first.revision, refreshed.revision);
});

test('command catalog ready payload never includes catalog content', () => {
  const payload = {
    ...commandCatalogPayload({
      catalog: catalog(),
      revision: 'revision-1',
      stale: false,
      refreshed: true,
    }),
  };
  assert.deepEqual(commandCatalogReadyPayload(payload, 'catalog-ref'), {
    revision: 'revision-1',
    notModified: false,
    stale: false,
    error: '',
    catalogRef: 'catalog-ref',
  });
});

test('command catalog invalidation forces the next request to reload', async () => {
  let loads = 0;
  const cache = new CommandCatalogCache();
  const loader = async () => {
    loads++;
    return catalog(`model-${loads}`);
  };
  const first = await cache.get('claude:/project', loader);
  cache.invalidate('claude:/project');
  const second = await cache.get('claude:/project', loader);
  assert.equal(loads, 2);
  assert.notEqual(first.revision, second.revision);
});
