// Device rows in SystemTable: each Bridge connection writes its own; /devices and the install
// script's name check read them; removing a device deletes it.
import { nowInt, truncate } from './util.mjs';

export function createDevices(table) {
  const pk = (accountId) => `DEVICE#${accountId}`;
  return {
    put: (accountId, device, displayName = '', os = '') => table.putItem({ Item: {
      pk: pk(accountId), sk: device, deviceName: device, deviceDisplayName: truncate(displayName || device, 64),
      os: truncate(os, 16), lastConnected: nowInt(),
    } }),
    async list(accountId) {
      const params = { KeyConditionExpression: '#pk = :pk', ExpressionAttributeNames: { '#pk': 'pk' },
        ExpressionAttributeValues: { ':pk': pk(accountId) } };
      const items = [];
      for (;;) {
        const page = await table.query(params);
        items.push(...page.Items);
        if (!page.LastEvaluatedKey) return items;
        params.ExclusiveStartKey = page.LastEvaluatedKey;
      }
    },
    delete: (accountId, device) => table.deleteItem({ Key: { pk: pk(accountId), sk: device } }),
  };
}
