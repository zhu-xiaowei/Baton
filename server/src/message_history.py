HISTORY_VERSION = "native-order-v2"


def ordered_partition(session_id):
    return f"{session_id}#{HISTORY_VERSION}"


def history_key(session_id):
    return {"sessionId": f"{session_id}#history", "sk": "current"}


def message_key(session_id, message, timestamp):
    order_key = message.get("orderKey", "")
    return {
        "sessionId": ordered_partition(session_id) if order_key else session_id,
        "sk": f"{order_key or timestamp}#{message['uuid']}",
    }


def history_partition(table, session_id):
    current = table.get_item(Key=history_key(session_id), ConsistentRead=True).get("Item", {})
    return ordered_partition(session_id) if current.get("version") == HISTORY_VERSION else session_id


def publish_history(table, session_id):
    table.put_item(Item={**history_key(session_id), "version": HISTORY_VERSION})
