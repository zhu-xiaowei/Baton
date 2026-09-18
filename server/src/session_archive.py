def is_codex(item):
    return item.get("runtime") == "codex" or str(item.get("sessionId", "")).startswith("codex:")


def is_archived(item):
    return is_codex(item) and item.get("archiveState") == "archived"


def archive_fields(item, root=None):
    if not is_codex(item):
        return {}
    return {
        "archiveState": item.get("archiveState", "unknown"),
        "archiveVersion": int(item.get("archiveVersion", 0)),
        "rootSessionId": (root or item).get("sessionId", ""),
        "rootArchiveState": (root or item).get("archiveState", "unknown"),
        "rootArchiveVersion": int((root or item).get("archiveVersion", 0)),
        "canSend": item.get("canSend", True) and not is_archived(item) and not is_archived(root or {}),
    }


def archive_context(item, get_parent):
    fields = archive_fields(item)
    if not fields:
        return fields
    root = item
    seen = {item.get("sessionId")}
    blocked = not fields["canSend"]
    while root.get("parentSessionId"):
        parent_id = root["parentSessionId"]
        if parent_id in seen:
            return {**fields, "rootSessionId": "", "rootArchiveState": "unknown", "rootArchiveVersion": 0, "canSend": False}
        seen.add(parent_id)
        root = get_parent(parent_id)
        if not root:
            return {**fields, "rootSessionId": "", "rootArchiveState": "unknown", "rootArchiveVersion": 0, "canSend": False}
        blocked = blocked or is_archived(root)
    return {**archive_fields(item, root), "canSend": fields["canSend"] and not blocked}
