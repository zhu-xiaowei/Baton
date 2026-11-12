"""v2 direct App ⇄ Bridge requests.

A Bridge binds a `bridge_data` socket on the data API to its control connection. Apps get
STS credentials (from /devices) for the data API, so requests and replies travel through the
API Gateway HTTP integration without Lambda.
"""

import hashlib
import json
import os
import re
import secrets
import time
import urllib.parse
import uuid

import boto3

CREDENTIAL_SECONDS = 3600
CREDENTIAL_REUSE_MARGIN = 600
JOIN_TICKET_SECONDS = 60
_credential_cache = {}


def data_endpoint():
    return os.environ.get("TERMINAL_DIRECT_ENDPOINT", "")


def _ticket_key(token):
    return "RPCJOIN#" + hashlib.sha256(token.encode()).hexdigest()


def callback_policy(endpoint, role_arn, region):
    """POST @connections/* on the data API: API Gateway authorizes the route template, not one socket."""
    parsed = urllib.parse.urlsplit(endpoint)
    api_id = (parsed.hostname or "").split(".")[0]
    stage = parsed.path.strip("/")
    if (parsed.scheme != "https" or "?" in endpoint or "#" in endpoint or not re.fullmatch(r"[a-z0-9]+", api_id)
            or not re.fullmatch(r"[A-Za-z0-9_-]+", stage)):
        raise ValueError("Invalid callback destination")
    partition, account = role_arn.split(":")[1], role_arn.split(":")[4]
    return {"Version": "2012-10-17", "Statement": [{"Effect": "Allow", "Action": "execute-api:ManageConnections",
        "Resource": f"arn:{partition}:execute-api:{region}:{account}:{api_id}/{stage}/POST/@connections/*"}]}


def storage_info(account_id):
    """Where this account's files travel: t/<accountId>/ in the attachment bucket (see transfer-store.mjs)."""
    bucket = os.environ.get("BRIDGE_IMAGES_BUCKET", "")
    if not bucket or not re.fullmatch(r"[0-9a-f]{16}", account_id):
        return None
    return {"bucket": bucket, "region": os.environ["AWS_REGION"], "accountId": account_id,
            "accelerate": os.environ.get("S3_UPLOAD_ACCELERATE", "false").lower() == "true"}


def session_policy(account_id, role_arn, region):
    """The data API, plus reading and writing this account's transfer prefix only."""
    policy = callback_policy(data_endpoint(), role_arn, region)
    storage = storage_info(account_id)
    if storage:
        partition = role_arn.split(":")[1]
        policy["Statement"].append({"Effect": "Allow", "Action": ["s3:GetObject", "s3:PutObject"],
            "Resource": f"arn:{partition}:s3:::{storage['bucket']}/t/{account_id}/*"})
    return policy


def issue_credentials(account_id, sts=None):
    """Credentials for an App or a Bridge of one account: the data API (API Gateway authorizes
    @connections on the route template, not per socket) and the account's transfer prefix."""
    cached = _credential_cache.get(account_id)
    if cached and cached["expiresAt"] - time.time() > CREDENTIAL_REUSE_MARGIN:
        return cached
    region = os.environ["AWS_REGION"]
    role_arn = os.environ["TERMINAL_DIRECT_ROLE_ARN"]
    sts = sts or boto3.client("sts", region_name=region)
    result = sts.assume_role(RoleArn=role_arn, RoleSessionName="rpc-" + uuid.uuid4().hex[:20],
        DurationSeconds=CREDENTIAL_SECONDS, Policy=json.dumps(session_policy(account_id, role_arn, region)))
    credentials = result["Credentials"]
    value = {"accessKeyId": credentials["AccessKeyId"], "secretAccessKey": credentials["SecretAccessKey"],
        "sessionToken": credentials["SessionToken"], "expiresAt": int(credentials["Expiration"].timestamp())}
    if len(_credential_cache) > 256:
        _credential_cache.clear()
    _credential_cache[account_id] = value
    return value


def rpc_info(account_id, query, sts=None):
    """Bridges an App can address directly, plus data-API credentials (see issue_credentials)."""
    bridges = [{"device": bridge.get("deviceName", ""), "dataId": bridge["rpcDataId"]}
               for bridge in query(account_id, "bridge") if bridge.get("rpcDataId")]
    return {"bridges": bridges, "endpoint": data_endpoint(), "credentials": issue_credentials(account_id, sts),
            "storage": storage_info(account_id)}


def notify_apps(account_id, query, post, sts=None):
    apps = query(account_id, "app_data")
    if not apps:
        return
    message = {"action": "direct_rpc", "type": "bridges", "rpc": rpc_info(account_id, query, sts)}
    for app in apps:
        post(data_endpoint(), app["connectionId"], message)


def handle_direct_rpc(body, conn, connection_id, endpoint, *, table, query, post, sts=None):
    operation = body.get("op")
    role = conn.get("role")
    account_id = conn.get("accountId", "")
    if operation == "credentials" and role == "bridge":
        post(endpoint, connection_id, {"action": "direct_rpc", "type": "credentials", "endpoint": data_endpoint(),
            "region": os.environ["AWS_REGION"], "credentials": issue_credentials(account_id, sts),
            "storage": storage_info(account_id)})
        return {"statusCode": 200}
    if operation == "bridge_token" and role == "bridge" and conn.get("deviceName"):
        token = secrets.token_hex(32)
        table.put_item(Item={"connectionId": _ticket_key(token), "accountId": account_id, "role": "rpc_join",
            "controlId": connection_id, "deviceName": conn["deviceName"], "ttl": int(time.time()) + JOIN_TICKET_SECONDS})
        post(endpoint, connection_id, {"action": "direct_rpc", "type": "token", "token": token})
        return {"statusCode": 200}
    if operation == "bridge_join" and role == "bridge_data":
        token = body.get("token")
        ticket = None
        if isinstance(token, str) and re.fullmatch(r"[0-9a-f]{64}", token):
            key = _ticket_key(token)
            ticket = table.get_item(Key={"connectionId": key}, ConsistentRead=True).get("Item")
            table.delete_item(Key={"connectionId": key})
        current = []
        if ticket and ticket.get("accountId") == account_id and int(ticket.get("ttl", 0)) >= time.time():
            current = query(account_id, "bridge", device=ticket["deviceName"])
        if not current or current[0]["connectionId"] != ticket["controlId"]:
            post(endpoint, connection_id, {"action": "direct_rpc", "type": "error"})
            return {"statusCode": 403}
        table.update_item(Key={"connectionId": ticket["controlId"]}, UpdateExpression="SET rpcDataId = :data",
            ConditionExpression="attribute_exists(connectionId)", ExpressionAttributeValues={":data": connection_id})
        table.update_item(Key={"connectionId": connection_id}, UpdateExpression="SET rpcControlId = :control",
            ConditionExpression="attribute_exists(connectionId)", ExpressionAttributeValues={":control": ticket["controlId"]})
        post(endpoint, connection_id, {"action": "direct_rpc", "type": "joined"})
        notify_apps(account_id, query, post, sts)
        return {"statusCode": 200}
    return {"statusCode": 403}


def direct_rpc_disconnect(connection, *, table, query, post, sts=None):
    """Called after the connection row was removed."""
    if not connection:
        return
    role = connection.get("role")
    if role == "bridge_data" and connection.get("rpcControlId"):
        try:
            table.update_item(Key={"connectionId": connection["rpcControlId"]}, UpdateExpression="REMOVE rpcDataId",
                ConditionExpression="rpcDataId = :data", ExpressionAttributeValues={":data": connection["connectionId"]})
        except Exception:
            return
    elif not (role == "bridge" and connection.get("rpcDataId")):
        return
    notify_apps(connection.get("accountId", ""), query, post, sts)
