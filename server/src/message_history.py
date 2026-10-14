from collections import OrderedDict
from threading import Lock


HISTORY_VERSION = "native-order-v2"
_CACHE_LIMIT = 512
_cache_lock = Lock()


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
    key = (HISTORY_VERSION, session_id)
    with _cache_lock:
        cache = getattr(table, "_ordered_history_cache", None)
        if cache is not None and key in cache:
            cache.move_to_end(key)
            return ordered_partition(session_id)
    current = table.get_item(Key=history_key(session_id), ConsistentRead=True).get("Item", {})
    if current.get("version") == HISTORY_VERSION:
        _remember_ordered_history(table, session_id)
        return ordered_partition(session_id)
    return session_id


def _remember_ordered_history(table, session_id):
    # Publication is monotonic. Missing markers must stay uncached during migration.
    with _cache_lock:
        cache = getattr(table, "_ordered_history_cache", None)
        if cache is None:
            cache = OrderedDict()
            table._ordered_history_cache = cache
        key = (HISTORY_VERSION, session_id)
        cache[key] = True
        cache.move_to_end(key)
        while len(cache) > _CACHE_LIMIT:
            cache.popitem(last=False)


def publish_history(table, session_id):
    table.put_item(Item={**history_key(session_id), "version": HISTORY_VERSION})
    _remember_ordered_history(table, session_id)
