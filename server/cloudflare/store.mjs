// The DynamoDB subset server/core uses (server/aws/dynamodb.mjs), over one SQLite table per Durable Object,
// and the router that sends each key to its object: an account's rows to its AccountObject, the global
// keys (token index, start tokens, pairing codes, recovery, rate counters) to one of 16 IndexObject shards.
const fail = (code, message = code) => Object.assign(new Error(message), { code });

// ---- Expressions: conditions (attribute_exists, attribute_not_exists, begins_with, = < >, AND/OR) ----
const TOKEN = /\s*(attribute_not_exists|attribute_exists|begins_with|AND\b|OR\b|[(),=<>]|[#:]?[\w.-]+)/y;
function tokenize(text) {
  const out = [];
  TOKEN.lastIndex = 0;
  for (let match; TOKEN.lastIndex < text.trimEnd().length && (match = TOKEN.exec(text));) out.push(match[1]);
  if (TOKEN.lastIndex < text.trimEnd().length) throw fail('ValidationException', `Bad expression: ${text}`);
  return out;
}

function parseCondition(text, names, values) {
  const tokens = tokenize(text);
  let at = 0;
  const next = () => tokens[at++];
  const expect = (token) => { if (next() !== token) throw fail('ValidationException', `Bad expression: ${text}`); };
  const operand = () => {
    const token = next();
    if (token.startsWith(':')) return () => values[token];
    const name = token.startsWith('#') ? names[token] : token;
    return (item) => item[name];
  };
  const primary = () => {
    const token = tokens[at];
    if (token === 'attribute_exists' || token === 'attribute_not_exists' || token === 'begins_with') {
      next(); expect('(');
      const a = operand();
      const b = token === 'begins_with' ? (expect(','), operand()) : null;
      expect(')');
      if (b) return (item) => typeof a(item) === 'string' && a(item).startsWith(b(item));
      return token === 'attribute_exists' ? (item) => a(item) !== undefined : (item) => a(item) === undefined;
    }
    const a = operand();
    const op = next();
    const b = operand();
    return (item) => compare(a(item), op, b(item));
  };
  const and = () => { let left = primary(); while (tokens[at] === 'AND') { next(); const l = left, r = primary(); left = (i) => l(i) && r(i); } return left; };
  const or = () => { let left = and(); while (tokens[at] === 'OR') { next(); const l = left, r = and(); left = (i) => l(i) || r(i); } return left; };
  const result = or();
  if (at !== tokens.length) throw fail('ValidationException', `Bad expression: ${text}`);
  return result;
}

function compare(a, op, b) {
  if (a === undefined || b === undefined) return false;
  if (op === '=') return JSON.stringify(a) === JSON.stringify(b);
  if (typeof a !== typeof b || !['string', 'number'].includes(typeof a)) return false;
  return op === '<' ? a < b : a > b;
}

// SET a = :v, #b = :w  ADD n :one  REMOVE c, d
function applyUpdate(item, text, names = {}, values = {}) {
  const name = (token) => (token.startsWith('#') ? names[token] : token);
  for (const [, clause, body] of text.matchAll(/\b(SET|ADD|REMOVE)\b([^]*?)(?=\b(?:SET|ADD|REMOVE)\b|$)/g)) {
    for (const part of body.split(',').map((p) => p.trim()).filter(Boolean)) {
      if (clause === 'REMOVE') { delete item[name(part)]; continue; }
      const [path, value] = clause === 'SET' ? part.split(/\s*=\s*/) : part.split(/\s+/);
      if (!(value in values)) throw fail('ValidationException', `Unsupported update: ${part}`);
      item[name(path)] = clause === 'ADD' ? (item[name(path)] ?? 0) + values[value] : values[value];
    }
  }
  return item;
}

// ---- One object's items table ----
export function createItems(sql) {
  sql.exec('CREATE TABLE IF NOT EXISTS items(pk TEXT NOT NULL, sk TEXT NOT NULL, v TEXT NOT NULL, ttl INTEGER, PRIMARY KEY(pk, sk)) WITHOUT ROWID');
  sql.exec('CREATE INDEX IF NOT EXISTS items_ttl ON items(ttl) WHERE ttl IS NOT NULL');
  let purged = 0;
  const read = (pk, sk) => { const row = sql.exec('SELECT v FROM items WHERE pk = ? AND sk = ?', pk, sk).toArray()[0]; return row && JSON.parse(row.v); };
  const write = (item) => {
    sql.exec('INSERT OR REPLACE INTO items VALUES(?, ?, ?, ?)', item.pk, item.sk, JSON.stringify(item), typeof item.ttl === 'number' ? item.ttl : null);
  };
  const remove = (pk, sk) => sql.exec('DELETE FROM items WHERE pk = ? AND sk = ?', pk, sk);
  const check = (params, item) => {
    if (params.ConditionExpression && !parseCondition(params.ConditionExpression, params.ExpressionAttributeNames, params.ExpressionAttributeValues)(item ?? {})) {
      throw fail('ConditionalCheckFailedException', 'The conditional request failed');
    }
  };
  // DynamoDB TTL: expired rows linger until deleted lazily; core checks ttl itself.
  const purge = () => {
    if (Date.now() - purged < 3600_000) return;
    purged = Date.now();
    sql.exec('DELETE FROM items WHERE ttl IS NOT NULL AND ttl < ?', Math.floor(Date.now() / 1000) - 86400);
  };

  const ops = {
    getItem: ({ Key }) => ({ Item: read(Key.pk, Key.sk) }),
    putItem(params) {
      check(params, read(params.Item.pk, params.Item.sk));
      write(params.Item);
      purge();
      return {};
    },
    updateItem(params) {
      const old = read(params.Key.pk, params.Key.sk);
      check(params, old);
      const item = applyUpdate(structuredClone(old ?? { ...params.Key }), params.UpdateExpression, params.ExpressionAttributeNames,
        params.ExpressionAttributeValues);
      write(item);
      return params.ReturnValues === 'ALL_NEW' ? { Attributes: item } : {};
    },
    deleteItem(params) {
      const old = read(params.Key.pk, params.Key.sk);
      check(params, old);
      if (old) remove(params.Key.pk, params.Key.sk);
      return params.ReturnValues === 'ALL_OLD' && old ? { Attributes: old } : {};
    },
    query(params) {
      const pk = queryPk(params);
      const match = parseCondition(params.KeyConditionExpression, params.ExpressionAttributeNames, params.ExpressionAttributeValues);
      const after = params.ExclusiveStartKey?.sk ?? '';
      const Items = [];
      for (const row of sql.exec('SELECT v FROM items WHERE pk = ? AND sk > ? ORDER BY sk', pk, after)) {
        const item = JSON.parse(row.v);
        if (!match(item)) continue;
        Items.push(item);
        if (Items.length === params.Limit) return { Items, LastEvaluatedKey: { pk, sk: item.sk } };
      }
      return { Items };
    },
    // All conditions first, then every write, in one SQLite transaction (the caller's transactionSync).
    transact(items) {
      const failed = items.some(({ Put, Update, Delete, ConditionCheck }) => {
        const params = Put ?? Update ?? Delete ?? ConditionCheck;
        const key = params.Key ?? params.Item;
        try { check(params, read(key.pk, key.sk)); return false; } catch { return true; }
      });
      if (failed) throw fail('TransactionCanceledException', 'Transaction cancelled, please refer cancellation reasons for specific reasons');
      for (const { Put, Update, Delete } of items) {
        if (Put) write(Put.Item);
        if (Update) ops.updateItem({ ...Update, ConditionExpression: undefined });
        if (Delete) remove(Delete.Key.pk, Delete.Key.sk);
      }
      return {};
    },
  };
  return ops;
}

// Every core query names the partition as `<pk> = :value` first.
function queryPk({ KeyConditionExpression: text, ExpressionAttributeValues: values }) {
  const value = /^\s*[#\w]+\s*=\s*(:\w+)/.exec(text)?.[1];
  if (!value) throw fail('ValidationException', `Unsupported key condition: ${text}`);
  return values[value];
}

// Results cross the RPC boundary as values; errors as { error, message } (RPC keeps no custom fields).
export function serve(items, transactionSync) {
  return (name, params) => {
    try {
      return { result: name === 'transact' ? transactionSync(() => items.transact(params)) : items[name](params) };
    } catch (error) {
      if (!error.code) throw error;
      return { error: error.code, message: error.message };
    }
  };
}

const ACCOUNT_KEY = /^(ACCOUNT|DEVICE|PUSH_DEVICE|NOTIFICATIONS)#([0-9a-f]{16})$/;
const hexDigit = (text) => { let h = 0; for (const c of text) h = (h * 31 + c.codePointAt(0)) >>> 0; return (h & 15).toString(16); };

// [kind, name]: an account object or an index shard.
export function home(pk, sk = '') {
  const account = ACCOUNT_KEY.exec(pk);
  if (account) return ['account', account[2]];
  if (pk === 'TOKEN') return ['index', hexDigit(sk)];
  const hashed = /^(TOKEN|PAIR|JOIN)#([0-9a-f])/.exec(pk); // keyed by a hash already
  return ['index', hashed ? hashed[2] : hexDigit(pk)];
}

// The `table` port: { getItem, putItem, updateItem, deleteItem, query, transactWriteItems }. `self` is the
// calling object ({ kind, name, call }) so its own keys need no RPC.
export function createTable(env, self = null) {
  const target = ([kind, name]) => {
    if (self && self.kind === kind && self.name === name) return self.call;
    const namespace = kind === 'account' ? env.ACCOUNT : env.INDEX;
    const stub = namespace.get(namespace.idFromName(kind === 'account' ? name : `index:${name}`));
    return (op, params) => stub.op(op, params);
  };
  const run = async (where, op, params) => {
    const reply = await target(where)(op, params);
    if (reply.error) throw fail(reply.error, reply.message);
    return reply.result;
  };
  const keyed = (op) => (params) => {
    const key = params.Key ?? params.Item;
    return run(home(key.pk, key.sk), op, params);
  };
  const where = (item) => { const p = Object.values(item)[0]; const key = p.Key ?? p.Item; return home(key.pk, key.sk); };
  return {
    getItem: keyed('getItem'),
    putItem: keyed('putItem'),
    updateItem: keyed('updateItem'),
    deleteItem: keyed('deleteItem'),
    query: async (params) => run(home(queryPk(params)), 'query', params),
    // Across objects: other objects' writes first, the first item's object atomically (conditions checked), then other
    // objects' deletes, so a failure at any point leaves the old state valid (core's rotateAndRevoke).
    async transactWriteItems({ TransactItems }) {
      const primary = JSON.stringify(where(TransactItems[0]));
      const groups = new Map();
      for (const item of TransactItems) {
        const at = JSON.stringify(where(item));
        if (!groups.has(at)) groups.set(at, []);
        groups.get(at).push(item);
      }
      const others = [...groups].filter(([at]) => at !== primary);
      const single = async (at, item) => {
        const [[kind, params]] = Object.entries(item);
        if (kind !== 'ConditionCheck') await run(JSON.parse(at), { Put: 'putItem', Update: 'updateItem', Delete: 'deleteItem' }[kind], params);
      };
      for (const [at, items] of others) for (const item of items.filter((i) => !i.Delete)) await single(at, item);
      await run(JSON.parse(primary), 'transact', groups.get(primary));
      // Committed: what is left is clean-up, never a reason to fail the removal.
      for (const [at, items] of others) {
        for (const item of items.filter((i) => i.Delete)) await single(at, item).catch((error) => console.log(`clean-up delete failed: ${error.message}`));
      }
      return {};
    },
  };
}
