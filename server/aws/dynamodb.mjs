// A DynamoDB table with plain values, as boto3's Table resource: the same operation names and
// parameters, items (un)marshalled, errors thrown with DynamoDB's code (`error.code`).
import { call, region } from './aws.mjs';

export function marshal(value) {
  if (value === null || value === undefined) return { NULL: true };
  if (typeof value === 'string') return { S: value };
  if (typeof value === 'number' || typeof value === 'bigint') return { N: String(value) };
  if (typeof value === 'boolean') return { BOOL: value };
  if (Array.isArray(value)) return { L: value.map(marshal) };
  return { M: marshalItem(value) };
}
const marshalItem = (item) => Object.fromEntries(Object.entries(item).map(([key, value]) => [key, marshal(value)]));

export function unmarshal(value) {
  const [[type, inner]] = Object.entries(value);
  if (type === 'N') return Number(inner);
  if (type === 'NULL') return null;
  if (type === 'L') return inner.map(unmarshal);
  if (type === 'M') return unmarshalItem(inner);
  if (type === 'NS') return inner.map(Number);
  return inner; // S, BOOL, B, SS, BS
}
const unmarshalItem = (item) => item && Object.fromEntries(Object.entries(item).map(([key, value]) => [key, unmarshal(value)]));

const MARSHALLED = ['Key', 'Item', 'ExpressionAttributeValues', 'ExclusiveStartKey'];
const RETURNED = ['Item', 'Attributes', 'LastEvaluatedKey'];

function request(TableName, params) {
  const out = { TableName, ...params };
  for (const name of MARSHALLED) if (out[name]) out[name] = marshalItem(out[name]);
  return out;
}

export function createTable(TableName) {
  async function send(operation, body) {
    const text = await call('dynamodb', { url: `https://dynamodb.${region()}.amazonaws.com/`, body: JSON.stringify(body),
      headers: { 'content-type': 'application/x-amz-json-1.0', 'x-amz-target': `DynamoDB_20120810.${operation}` } });
    const result = JSON.parse(text);
    for (const name of RETURNED) if (result[name]) result[name] = unmarshalItem(result[name]);
    if (result.Items) result.Items = result.Items.map(unmarshalItem);
    return result;
  }
  const operation = (name) => (params) => send(name, request(TableName, params));
  return {
    name: TableName,
    getItem: operation('GetItem'),
    putItem: operation('PutItem'),
    updateItem: operation('UpdateItem'),
    deleteItem: operation('DeleteItem'),
    query: async (params) => ({ Items: [], ...await operation('Query')(params) }),
    // botocore fills the idempotency token, so a retried transaction that had committed succeeds.
    transactWriteItems: ({ TransactItems }) => send('TransactWriteItems', { ClientRequestToken: crypto.randomUUID(),
      TransactItems: TransactItems.map((item) => Object.fromEntries(Object.entries(item).map(([kind, params]) => [kind, request(TableName, params)]))),
    }),
  };
}
