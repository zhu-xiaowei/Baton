def apply_metadata_update(table, kwargs):
    expression = kwargs.get("UpdateExpression", "")
    if not expression.startswith("SET #m0"):
        return
    key = kwargs["Key"]
    existing = table.get_item(Key=key).get("Item", {})
    item = {**existing, **key}
    names = kwargs["ExpressionAttributeNames"]
    values = kwargs["ExpressionAttributeValues"]
    for name, field in names.items():
        if name.startswith("#m"):
            item[field] = values[name.replace("#", ":")]
        elif name.startswith("#r"):
            item.pop(field, None)
    table.items.append(item)
