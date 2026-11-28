// Device rows in SystemTable: a Bridge connection writes its own when new or renamed; /devices and the install
// script's name check read them; removing a device deletes it.
import { truncate } from './util.mjs';

export function createDevices(table) {
  const pk = (accountId) => `DEVICE#${accountId}`;
  return {
    // `sealed`: a hosted computer's { nameSealed, nameTag } (its display name under K; the tag finds duplicates).
    async put(accountId, device, displayName = '', sealed = {}) {
      const Item = { pk: pk(accountId), sk: device, deviceName: device, deviceDisplayName: truncate(displayName || device, 64), ...sealed };
      const row = (await table.getItem({ Key: { pk: Item.pk, sk: device } })).Item;
      if (['deviceDisplayName', 'nameSealed', 'nameTag'].some((field) => row?.[field] !== Item[field])) await table.putItem({ Item });
    },
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
