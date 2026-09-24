import asyncio
import os
import sys
from types import SimpleNamespace

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'server', 'src'))

import bridge_sync
from project.session_ws import handle_session_rename


BODY = {
    'action': 'rename_session', 'requestId': '550e8400-e29b-41d4-a716-446655440000',
    'sessionId': 'codex:22222222-2222-4222-8222-222222222222',
    'device': 'Mac', 'projectHash': 'project', 'name': 'New title',
}


def test_rename_routes_only_to_selected_device_and_same_account_reply():
    sent = []
    target = {'accountId': 'account', 'role': 'app'}
    dependencies = dict(
        query_connections=lambda account, role: [
            {'connectionId': 'other', 'deviceName': 'Other'},
            {'connectionId': 'bridge', 'deviceName': 'Mac'},
        ] if role == 'bridge' else [{'connectionId': 'viewer'}],
        post_to_connection=lambda endpoint, connection, payload: sent.append((connection, payload)),
        connections_table=SimpleNamespace(get_item=lambda **kwargs: {'Item': target}),
        bridge_device='Mac',
    )
    result = handle_session_rename(BODY, 'app', 'app', 'account', 'endpoint', **dependencies)
    assert result['statusCode'] == 200
    assert len(sent) == 1 and sent[0][0] == 'bridge'
    assert sent[0][1]['replyConnectionId'] == 'app'
    response = {**sent[0][1], 'ok': True, 'synced': True}
    sent.clear()
    handle_session_rename(response, 'bridge', 'bridge', 'account', 'endpoint', **dependencies)
    assert [item[0] for item in sent] == ['app', 'viewer']
    assert sent[1][1]['action'] == 'session_title_changed'
    target['accountId'] = 'another-account'
    sent.clear()
    assert handle_session_rename(response, 'bridge', 'bridge', 'account', 'endpoint', **dependencies)['statusCode'] == 403
    assert not sent
    handle_session_rename({**BODY, 'device': 'Offline'}, 'app', 'app', 'account', 'endpoint', **dependencies)
    assert sent[-1][1]['error'] == 'Bridge offline.'
    handle_session_rename({**BODY, 'name': ' '}, 'app', 'app', 'account', 'endpoint', **dependencies)
    assert sent[-1][1]['ok'] is False


def test_title_sync_only_updates_existing_preview_without_touching_status(monkeypatch):
    writes = []
    monkeypatch.setattr(bridge_sync, '_tables', lambda: (
        SimpleNamespace(update_item=lambda **kwargs: writes.append(kwargs)), None,
    ))
    request = bridge_sync.SessionTitleRequest(
        deviceName='Mac', projectHash='project', sessionId=BODY['sessionId'], name=' New title ',
    )
    result = asyncio.run(bridge_sync.update_session_title(request, SimpleNamespace(headers={'x-api-key': 'key'})))
    assert result == {'ok': True}
    assert writes[0]['Key']['sk'] == f"SESS#Mac#project#{BODY['sessionId']}"
    assert writes[0]['UpdateExpression'] == 'SET preview = :name'
    assert writes[0]['ConditionExpression'] == 'attribute_exists(sk)'
    assert writes[0]['ExpressionAttributeValues'] == {':name': 'New title'}
