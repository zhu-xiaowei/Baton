import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "server", "src"))

import message_history


class HistoryTable:
    def __init__(self):
        self.items = {}
        self.reads = []
        self.fail_write = False

    def get_item(self, Key, ConsistentRead):
        assert ConsistentRead is True
        self.reads.append(Key)
        return {"Item": self.items.get(Key["sessionId"], {})}

    def put_item(self, Item):
        if self.fail_write:
            raise RuntimeError("write failed")
        self.items[Item["sessionId"]] = Item


def test_published_history_reuses_mapping_without_caching_messages():
    table = HistoryTable()
    table.items["session#history"] = {"version": message_history.HISTORY_VERSION}

    assert message_history.history_partition(table, "session") == message_history.ordered_partition("session")
    assert message_history.history_partition(table, "session") == message_history.ordered_partition("session")
    assert len(table.reads) == 1


def test_missing_marker_is_reread_and_external_publication_is_visible():
    table = HistoryTable()
    assert message_history.history_partition(table, "session") == "session"
    assert message_history.history_partition(table, "session") == "session"
    table.items["session#history"] = {"version": message_history.HISTORY_VERSION}
    assert message_history.history_partition(table, "session") == message_history.ordered_partition("session")
    assert len(table.reads) == 3


def test_publication_seeds_cache_only_after_successful_write():
    table = HistoryTable()
    table.fail_write = True
    with pytest.raises(RuntimeError):
        message_history.publish_history(table, "session")
    assert message_history.history_partition(table, "session") == "session"

    table.fail_write = False
    message_history.publish_history(table, "session")
    assert message_history.history_partition(table, "session") == message_history.ordered_partition("session")
    assert len(table.reads) == 1
    assert message_history.history_partition(HistoryTable(), "session") == "session"


def test_history_cache_is_bounded(monkeypatch):
    monkeypatch.setattr(message_history, "_CACHE_LIMIT", 2)
    table = HistoryTable()
    for session in ("a", "b", "c"):
        message_history.publish_history(table, session)

    assert len(table._ordered_history_cache) == 2
    assert message_history.history_partition(table, "a") == message_history.ordered_partition("a")
    assert len(table.reads) == 1
