import re
import uuid


def _valid_request(body):
    try:
        uuid.UUID(body.get('requestId', ''))
        uuid.UUID(body.get('sessionId', '').removeprefix('codex:'))
    except (ValueError, TypeError, AttributeError):
        return False
    name = body.get('name')
    return isinstance(name, str) and 0 < len(name.strip()) <= 200 \
        and not re.search(r'[\x00-\x1f\x7f]', name.strip()) \
        and isinstance(body.get('device'), str) and bool(body['device']) \
        and isinstance(body.get('projectHash'), str) and bool(body['projectHash'])


def handle_session_rename(body, role, connection_id, account_id, endpoint, *,
                          query_connections, post_to_connection, connections_table,
                          bridge_device=''):
    if role == 'app':
        if not _valid_request(body):
            post_to_connection(endpoint, connection_id, {
                'action': 'rename_session', 'requestId': body.get('requestId'),
                'ok': False, 'error': 'Invalid session rename request.',
            })
            return {'statusCode': 400}
        payload = {key: body[key] for key in (
            'requestId', 'sessionId', 'projectHash', 'device', 'name',
        )}
        payload.update(action='rename_session', replyConnectionId=connection_id)
        delivered = False
        for bridge in query_connections(account_id, 'bridge'):
            if bridge.get('deviceName') == body['device']:
                delivered = post_to_connection(endpoint, bridge['connectionId'], payload) is not False
                if delivered:
                    break
        if not delivered:
            post_to_connection(endpoint, connection_id, {
                'action': 'rename_session', 'requestId': body['requestId'],
                'ok': False, 'error': 'Bridge offline.',
            })
        return {'statusCode': 200}

    if role != 'bridge':
        return {'statusCode': 403}
    reply_id = body.get('replyConnectionId')
    if not reply_id:
        return {'statusCode': 400}
    target = connections_table.get_item(Key={'connectionId': reply_id}).get('Item', {})
    if target.get('accountId') != account_id or target.get('role') != 'app':
        return {'statusCode': 403}
    payload = dict(body)
    payload.pop('replyConnectionId', None)
    payload['device'] = bridge_device
    post_to_connection(endpoint, reply_id, payload)
    if body.get('ok') is True:
        notification = {key: payload.get(key) for key in ('sessionId', 'projectHash', 'device', 'name')}
        notification['action'] = 'session_title_changed'
        for app in query_connections(account_id, 'app'):
            if app['connectionId'] != reply_id:
                post_to_connection(endpoint, app['connectionId'], notification)
    return {'statusCode': 200}
