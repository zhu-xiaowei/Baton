"""Control plane for a loopback-only preview tunnel on the terminal data API."""

import hmac
import json
import os
import secrets
import time
from concurrent.futures import ThreadPoolExecutor

import boto3
from botocore.exceptions import ClientError

from terminal_direct_ws import CONNECTION, UUID, callback_policy, conditional, token_hash


_sts = None
MAX_TUNNELS_PER_CONNECTION = 4


def session_key(tunnel_id):
    return "preview-tunnel:" + tunnel_id


class PreviewSessions:
    def __init__(self, table, query, post, disconnect, endpoint, data_endpoint, role_arn, region, sts):
        self.table, self.query, self.post, self.disconnect = table, query, post, disconnect
        self.endpoint, self.data_endpoint, self.role_arn, self.region, self.sts = (
            endpoint, data_endpoint, role_arn, region, sts)
        if endpoint == data_endpoint:
            raise ValueError("Preview data API must be isolated from control API")

    def get(self, connection_id):
        return self.table.get_item(Key={"connectionId": connection_id}, ConsistentRead=True).get("Item")

    def notify(self, connection_id, session, kind, **fields):
        return self.post(self.endpoint, connection_id, {
            "action": "preview_tunnel", "v": 1, "type": kind,
            "tunnelId": session["tunnelId"], "device": session["device"],
            "port": int(session["port"]), **fields})

    def claim(self, connection_id, tunnel_id):
        self.table.update_item(Key={"connectionId": connection_id},
            UpdateExpression="ADD previewTunnelIds :ids",
            ConditionExpression="attribute_exists(connectionId) AND (attribute_not_exists(previewTunnelIds) OR size(previewTunnelIds) < :limit)",
            ExpressionAttributeValues={":ids": {tunnel_id}, ":limit": MAX_TUNNELS_PER_CONNECTION})

    def release(self, connection_id, tunnel_id):
        try:
            self.table.update_item(Key={"connectionId": connection_id},
                UpdateExpression="DELETE previewTunnelIds :ids",
                ConditionExpression="attribute_exists(connectionId)",
                ExpressionAttributeValues={":ids": {tunnel_id}})
        except ClientError as error:
            if not conditional(error):
                raise

    def close(self, tunnel_id, reason=None):
        try:
            session = self.table.update_item(Key={"connectionId": session_key(tunnel_id)},
                UpdateExpression="SET #state = :closed, #ttl = :ttl REMOVE appToken, bridgeToken, frameKey",
                ConditionExpression="attribute_exists(connectionId) AND #state <> :closed",
                ExpressionAttributeNames={"#state": "state", "#ttl": "ttl"},
                ExpressionAttributeValues={":closed": "closed", ":ttl": int(time.time()) + 120},
                ReturnValues="ALL_NEW")["Attributes"]
        except ClientError as error:
            if conditional(error):
                return
            raise
        for side in ("app", "bridge"):
            control_id = session.get(side + "Control")
            if control_id:
                self.notify(control_id, session, "closed", **({"reason": reason[:256]} if reason else {}))
            data_id = session.get(side + "Data")
            if data_id:
                self.disconnect(self.data_endpoint, data_id)
            for connection_id in (control_id, data_id):
                if connection_id:
                    self.release(connection_id, tunnel_id)

    def open(self, body, connection, connection_id):
        if connection.get("role") != "app":
            raise PermissionError("App control connection required")
        device, port = body.get("device"), body.get("port")
        if not isinstance(device, str) or not 1 <= len(device) <= 128 or any(ord(c) < 32 for c in device):
            raise ValueError("Invalid device")
        if type(port) is not int or not 1 <= port <= 65535:
            raise ValueError("Invalid port")
        bridges = self.query(connection["accountId"], "bridge", device=device)
        if len(bridges) != 1:
            raise ValueError("Device offline or duplicate Bridge connections")
        bridge = self.get(bridges[0]["connectionId"])
        if (not bridge or bridge.get("role") != "bridge"
                or bridge.get("accountId") != connection["accountId"]
                or bridge.get("deviceName") != device
                or bridge.get("previewProtocol") != 1):
            raise ValueError("Bridge preview support unavailable")
        tunnel_id = body["tunnelId"]
        tokens = {side: secrets.token_hex(32) for side in ("app", "bridge")}
        now = int(time.time())
        session = {
            "connectionId": session_key(tunnel_id), "role": "preview_tunnel_session",
            "tunnelId": tunnel_id, "accountId": connection["accountId"],
            "device": device, "port": port,
            "appControl": connection_id, "bridgeControl": bridge["connectionId"],
            "state": "joining", "appToken": token_hash(tokens["app"]),
            "bridgeToken": token_hash(tokens["bridge"]),
            "expiresAt": now + 45, "ttl": now + 1800,
            "frameKey": secrets.token_hex(32),
        }
        self.table.put_item(Item=session, ConditionExpression="attribute_not_exists(connectionId)")
        try:
            self.claim(connection_id, tunnel_id)
            self.claim(bridge["connectionId"], tunnel_id)
            for side in ("bridge", "app"):
                if self.notify(session[side + "Control"], session, "offer",
                        side=side, joinToken=tokens[side], dataEndpoint=self.data_endpoint) is False:
                    raise ValueError("Control connection disconnected")
        except Exception:
            self.close(tunnel_id)
            raise

    def join(self, body, connection, connection_id):
        if (connection.get("role") != "preview_data"
                or connection.get("terminalDataEndpoint") != self.data_endpoint):
            raise PermissionError("Dedicated preview data connection required")
        side, token = body.get("side"), body.get("joinToken")
        session = self.get(session_key(body["tunnelId"]))
        if (side not in ("app", "bridge") or not isinstance(token, str) or len(token) != 64 or not session
                or session.get("state") != "joining" or session.get("expiresAt", 0) <= time.time()
                or session.get("accountId") != connection.get("accountId")
                or not hmac.compare_digest(session.get(side + "Token", ""), token_hash(token))):
            raise PermissionError("Invalid or expired join capability")
        if not CONNECTION.fullmatch(connection_id):
            raise ValueError("Unsupported connection ID")
        self.claim(connection_id, session["tunnelId"])
        field = side + "Data"
        try:
            self.table.update_item(Key={"connectionId": session["connectionId"]},
                UpdateExpression="SET #data = :connection",
                ConditionExpression="#state = :joining AND attribute_not_exists(#data)",
                ExpressionAttributeNames={"#data": field, "#state": "state"},
                ExpressionAttributeValues={":connection": connection_id, ":joining": "joining"})
        except Exception:
            self.release(connection_id, session["tunnelId"])
            raise
        self.activate(session["tunnelId"])

    def activate(self, tunnel_id):
        try:
            session = self.table.update_item(Key={"connectionId": session_key(tunnel_id)},
                UpdateExpression="SET #state = :issuing REMOVE appToken, bridgeToken",
                ConditionExpression="#state = :joining AND attribute_exists(appData) AND attribute_exists(bridgeData)",
                ExpressionAttributeNames={"#state": "state"},
                ExpressionAttributeValues={":issuing": "issuing", ":joining": "joining"},
                ReturnValues="ALL_NEW")["Attributes"]
        except ClientError as error:
            if conditional(error):
                return
            raise
        try:
            self.issue(session, "issuing")
        except Exception:
            self.close(tunnel_id, "Preview authorization failed")
            raise

    def issue(self, session, expected_state):
        for side in ("app", "bridge"):
            for field, role in ((side + "Control", side), (side + "Data", "preview_data")):
                record = self.get(session[field])
                if (not record or record.get("role") != role
                        or record.get("accountId") != session["accountId"]
                        or session["tunnelId"] not in record.get("previewTunnelIds", set())
                        or (role == "preview_data"
                            and record.get("terminalDataEndpoint") != self.data_endpoint)):
                    raise PermissionError("Preview connection changed")

        def credentials(side):
            response = self.sts.assume_role(
                RoleArn=self.role_arn,
                RoleSessionName="preview-" + side + "-" + session["tunnelId"],
                DurationSeconds=900,
                Policy=json.dumps(callback_policy(self.data_endpoint, self.role_arn, self.region)))
            values = response["Credentials"]
            return {"accessKeyId": values["AccessKeyId"],
                "secretAccessKey": values["SecretAccessKey"],
                "sessionToken": values["SessionToken"],
                "expiresAt": int(values["Expiration"].timestamp())}
        with ThreadPoolExecutor(max_workers=2) as executor:
            results = dict(zip(("app", "bridge"), executor.map(credentials, ("app", "bridge"))))
        expires = min(result["expiresAt"] for result in results.values())
        self.table.update_item(Key={"connectionId": session["connectionId"]},
            UpdateExpression="SET #state = :active, expiresAt = :expires, issuedAt = :now, #ttl = :ttl",
            ConditionExpression="#state = :expected",
            ExpressionAttributeNames={"#state": "state", "#ttl": "ttl"},
            ExpressionAttributeValues={":active": "active", ":expected": expected_state,
                ":expires": expires, ":now": int(time.time()), ":ttl": expires + 120})
        for side, peer in (("bridge", "app"), ("app", "bridge")):
            if self.notify(session[side + "Control"], session, "ready", side=side,
                    connectionId=session[side + "Data"], peerConnectionId=session[peer + "Data"],
                    endpoint=self.data_endpoint, region=self.region,
                    credentials=results[side], frameKey=session["frameKey"]) is False:
                self.close(session["tunnelId"])
                return

    def control(self, body, connection, connection_id):
        session = self.get(session_key(body["tunnelId"]))
        if (not session or session.get("accountId") != connection.get("accountId")
                or connection_id not in (session["appControl"], session["bridgeControl"])):
            raise PermissionError("Preview control owner mismatch")
        if body["op"] == "close":
            self.close(session["tunnelId"])
            return
        if connection_id != session["appControl"] or session.get("state") != "active":
            raise PermissionError("Only active app may renew")
        if session.get("issuedAt", 0) + 60 > time.time():
            return
        if session.get("expiresAt", 0) <= time.time():
            self.close(session["tunnelId"], "Preview authorization expired")
            return
        try:
            self.issue(session, "active")
        except Exception:
            self.close(session["tunnelId"], "Preview authorization renewal failed")
            raise


def service(endpoint, table, query, post, disconnect):
    global _sts
    role_arn = os.environ.get("TERMINAL_DIRECT_ROLE_ARN")
    data_endpoint = os.environ.get("TERMINAL_DIRECT_ENDPOINT")
    if not role_arn or not data_endpoint:
        raise ValueError("Preview transport unavailable")
    if _sts is None:
        _sts = boto3.client("sts", region_name=os.environ.get("AWS_REGION", "ap-northeast-1"))
    return PreviewSessions(table, query, post, disconnect, os.environ["WS_API_ENDPOINT"],
        data_endpoint, role_arn, os.environ.get("AWS_REGION", "ap-northeast-1"), _sts)


def handle_preview_tunnel(body, connection, connection_id, endpoint, *, table, query, post, disconnect):
    tunnel_id = body.get("tunnelId")
    if (body.get("v") != 1 or not isinstance(tunnel_id, str) or not UUID.fullmatch(tunnel_id)
            or len(json.dumps(body).encode()) > 8192
            or body.get("op") not in ("open", "join", "renew", "close")):
        return {"statusCode": 400}
    try:
        manager = service(endpoint, table, query, post, disconnect)
        if body["op"] == "open":
            manager.open(body, connection, connection_id)
        elif body["op"] == "join":
            manager.join(body, connection, connection_id)
        else:
            manager.control(body, connection, connection_id)
        return {"statusCode": 200}
    except PermissionError:
        message, status = "Invalid preview authorization", 403
    except (ValueError, ClientError) as error:
        message, status = str(error) if isinstance(error, ValueError) else "Preview busy", 400
    except Exception:
        message, status = "Preview initialization failed", 500
    post(endpoint, connection_id, {"action": "preview_tunnel", "v": 1,
        "type": "error", "tunnelId": tunnel_id, "message": message})
    return {"statusCode": status}


def preview_tunnel_disconnect(connection, endpoint, *, table, query, post, disconnect):
    for tunnel_id in (connection or {}).get("previewTunnelIds", set()):
        if isinstance(tunnel_id, str) and UUID.fullmatch(tunnel_id):
            service(endpoint, table, query, post, disconnect).close(tunnel_id)
