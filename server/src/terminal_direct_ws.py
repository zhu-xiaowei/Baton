import hashlib
import hmac
import json
import os
import re
import secrets
import time
import urllib.parse
from concurrent.futures import ThreadPoolExecutor

import boto3
from botocore.exceptions import ClientError


UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)
CONNECTION = re.compile(r"^[A-Za-z0-9_+=.-]{1,256}$")
_sts = None


def conditional(error):
    return isinstance(error, ClientError) and error.response["Error"]["Code"] == "ConditionalCheckFailedException"


def session_key(terminal_id):
    return "terminal-direct:" + terminal_id


def token_hash(token):
    return hashlib.sha256(token.encode()).hexdigest()


def callback_policy(endpoint, role_arn, region):
    parsed = urllib.parse.urlsplit(endpoint)
    api_id = (parsed.hostname or "").split(".")[0]
    stage = parsed.path.strip("/")
    if (parsed.scheme != "https" or "?" in endpoint or "#" in endpoint or not re.fullmatch(r"[a-z0-9]+", api_id)
            or not re.fullmatch(r"[A-Za-z0-9_-]+", stage)):
        raise ValueError("Invalid callback destination")
    partition, account = role_arn.split(":")[1], role_arn.split(":")[4]
    return {"Version": "2012-10-17", "Statement": [{"Effect": "Allow", "Action": "execute-api:ManageConnections",
        "Resource": f"arn:{partition}:execute-api:{region}:{account}:{api_id}/{stage}/POST/@connections/*"}]}


class DirectSessions:
    def __init__(self, table, query, post, disconnect, endpoint, role_arn, region, sts, data_endpoint):
        self.table, self.query, self.post, self.disconnect = table, query, post, disconnect
        self.endpoint, self.role_arn, self.region, self.sts = endpoint, role_arn, region, sts
        if data_endpoint == endpoint:
            raise ValueError("Terminal data API must be isolated from the control API")
        self.data_endpoint = data_endpoint

    def get(self, key):
        return self.table.get_item(Key={"connectionId": key}, ConsistentRead=True).get("Item")

    def notify(self, target, session, kind, **fields):
        return self.post(self.endpoint, target, {"action": "terminal_direct", "v": 1,
            "terminalId": session["terminalId"], "device": session["device"], "type": kind,
            **({"projectHash": session["projectHash"]} if "projectHash" in session else {}), **fields})

    def release(self, connection_id, terminal_id):
        try:
            self.table.update_item(Key={"connectionId": connection_id}, UpdateExpression="REMOVE terminalDirectId",
                ConditionExpression="terminalDirectId = :terminal", ExpressionAttributeValues={":terminal": terminal_id})
        except ClientError as error:
            if not conditional(error):
                raise

    def claim(self, connection_id, terminal_id):
        self.table.update_item(Key={"connectionId": connection_id}, UpdateExpression="SET terminalDirectId = :terminal",
            ConditionExpression="attribute_exists(connectionId) AND attribute_not_exists(terminalDirectId)",
            ExpressionAttributeValues={":terminal": terminal_id})

    def claim_shared(self, connection_id, terminal_id):
        self.table.update_item(Key={"connectionId": connection_id},
            UpdateExpression="ADD terminalDirectIds :ids",
            ConditionExpression="attribute_exists(connectionId) AND (attribute_not_exists(terminalDirectIds) OR size(terminalDirectIds) < :limit)",
            ExpressionAttributeValues={":ids": {terminal_id}, ":limit": 16})

    def release_shared(self, connection_id, terminal_id):
        try:
            self.table.update_item(Key={"connectionId": connection_id},
                UpdateExpression="DELETE terminalDirectIds :ids",
                ConditionExpression="attribute_exists(connectionId)", ExpressionAttributeValues={":ids": {terminal_id}})
        except ClientError as error:
            if not conditional(error):
                raise

    def close(self, terminal_id, reason="Terminal connection closed. Start a new session."):
        session = self.get(session_key(terminal_id))
        if not session or session.get("state") == "closed":
            return
        try:
            self.table.update_item(Key={"connectionId": session_key(terminal_id)},
                UpdateExpression="SET #state = :closed, #ttl = :ttl REMOVE appToken, bridgeToken, frameKey",
                ConditionExpression="#state <> :closed", ExpressionAttributeNames={"#state": "state", "#ttl": "ttl"},
                ExpressionAttributeValues={":closed": "closed", ":ttl": int(time.time()) + 60})
        except ClientError as error:
            if conditional(error):
                return
            raise
        for side in ["app", "bridge"]:
            control_id = session[side + "Control"]
            if side == "bridge" and "projectHash" in session:
                self.release_shared(control_id, terminal_id)
            else:
                self.release(control_id, terminal_id)
            self.notify(control_id, session, "closed", message=reason)
            data_id = session.get(side + "Data")
            if data_id:
                self.disconnect(self.data_endpoint, data_id)
                self.table.delete_item(Key={"connectionId": data_id})

    def available_control(self, connection_id):
        record = self.get(connection_id)
        if not record:
            raise PermissionError("Control connection is gone")
        previous = record.get("terminalDirectId")
        if previous:
            session = self.get(session_key(previous))
            if session and session.get("state") != "closed" and session.get("expiresAt", 0) > time.time():
                raise ValueError("Terminal busy. Close the previous tab and retry.")
            if session:
                self.close(previous)
            self.release(connection_id, previous)
        return record

    def open(self, body, connection, connection_id):
        if connection.get("role") != "app":
            raise PermissionError("App control connection required")
        device = body.get("device")
        if not isinstance(device, str) or not 1 <= len(device) <= 128 or any(ord(value) < 32 for value in device):
            raise ValueError("Invalid device")
        project = body.get("projectHash")
        shared = "projectHash" in body
        if shared and (not isinstance(project, str) or not 1 <= len(project.encode()) <= 2048
                or any(ord(value) < 32 for value in project)):
            raise ValueError("Invalid project")
        candidates = [item for item in self.query(connection["accountId"], "bridge") if item.get("deviceName") == device]
        if len(candidates) != 1:
            raise ValueError("Device offline or duplicate Bridge connections.")
        bridge = self.get(candidates[0]["connectionId"]) if shared else self.available_control(candidates[0]["connectionId"])
        if (not bridge or bridge.get("role") != "bridge" or bridge.get("accountId") != connection["accountId"]
                or bridge.get("deviceName") != device
                or (shared and bridge.get("terminalProtocol") != 2)
                or (not shared and bridge.get("bridgeVersion") != "xterm-direct-1")):
            raise ValueError("Update Bridge on this device to use the terminal.")
        initial = body.get("initialOpen")
        if initial is not None:
            if (not shared or not isinstance(initial, dict)
                    or type(initial.get("cols")) is not int or not 2 <= initial["cols"] <= 500
                    or type(initial.get("rows")) is not int or not 1 <= initial["rows"] <= 200
                    or (initial.get("sessionId") is not None and (not isinstance(initial["sessionId"], str)
                        or not UUID.fullmatch(initial["sessionId"])))):
                raise ValueError("Invalid initial terminal request")
            initial = {"cols": initial["cols"], "rows": initial["rows"], "sessionId": initial.get("sessionId")}
        self.available_control(connection_id)
        terminal_id = body["terminalId"]
        tokens = {side: secrets.token_hex(32) for side in ["app", "bridge"]}
        now = int(time.time())
        session = {"connectionId": session_key(terminal_id), "terminalId": terminal_id,
            "role": "terminal_direct_session", "accountId": connection["accountId"], "device": device,
            "appControl": connection_id, "bridgeControl": bridge["connectionId"], "state": "joining",
            "appToken": token_hash(tokens["app"]), "bridgeToken": token_hash(tokens["bridge"]),
            "expiresAt": now + 45, "ttl": now + 1800, "endpoint": self.endpoint, "frameKey": secrets.token_hex(32)}
        if shared:
            session["projectHash"] = project
        if initial is not None and bridge.get("terminalStartup") == 1:
            session["initialOpen"] = initial
        self.table.put_item(Item=session, ConditionExpression="attribute_not_exists(connectionId)")
        try:
            if shared:
                self.claim_shared(bridge["connectionId"], terminal_id)
            else:
                self.claim(bridge["connectionId"], terminal_id)
            self.claim(connection_id, terminal_id)
            for side in ["bridge", "app"]:
                if self.notify(session[side + "Control"], session, "offer", side=side, joinToken=tokens[side],
                        dataEndpoint=self.data_endpoint,
                        **({"initialOpen": session["initialOpen"]} if "initialOpen" in session else {})) is False:
                    raise ValueError("Control connection disconnected")
        except Exception:
            self.close(terminal_id)
            raise

    def join(self, body, connection, connection_id):
        if connection.get("role") != "terminal_data" or connection.get("terminalDataEndpoint") != self.data_endpoint:
            raise PermissionError("Dedicated data connection required")
        side, token = body.get("side"), body.get("joinToken")
        session = self.get(session_key(body["terminalId"]))
        if (side not in ["app", "bridge"] or not isinstance(token, str) or len(token) != 64 or not session
                or session.get("state") != "joining" or session.get("expiresAt", 0) <= time.time()
                or session.get("accountId") != connection.get("accountId")
                or not hmac.compare_digest(session.get(side + "Token", ""), token_hash(token))):
            raise PermissionError("Invalid or expired join capability")
        if not CONNECTION.fullmatch(connection_id):
            raise ValueError("Unsupported connection ID")
        self.claim(connection_id, session["terminalId"])
        field = side + "Data"
        try:
            self.table.update_item(Key={"connectionId": session["connectionId"]},
                UpdateExpression="SET #data = :connection", ConditionExpression="#state = :joining AND attribute_not_exists(#data)",
                ExpressionAttributeNames={"#data": field, "#state": "state"},
                ExpressionAttributeValues={":connection": connection_id, ":joining": "joining"})
        except Exception:
            self.release(connection_id, session["terminalId"])
            raise
        self.activate(session["terminalId"])

    def activate(self, terminal_id):
        try:
            session = self.table.update_item(Key={"connectionId": session_key(terminal_id)},
                UpdateExpression="SET #state = :issuing REMOVE appToken, bridgeToken",
                ConditionExpression="#state = :joining AND attribute_exists(appData) AND attribute_exists(bridgeData)",
                ExpressionAttributeNames={"#state": "state"},
                ExpressionAttributeValues={":issuing": "issuing", ":joining": "joining"}, ReturnValues="ALL_NEW")["Attributes"]
        except ClientError as error:
            if conditional(error):
                return
            raise
        try:
            self.issue(session, "issuing")
        except Exception:
            self.close(terminal_id, "Terminal authorization failed. Reconnect.")
            raise

    def issue(self, session, expected_state):
        for side in ["app", "bridge"]:
            for field, role in [(side + "Control", side), (side + "Data", "terminal_data")]:
                record = self.get(session[field])
                attached = (session["terminalId"] in record.get("terminalDirectIds", set())
                    if record and field == "bridgeControl" and "projectHash" in session
                    else record and record.get("terminalDirectId") == session["terminalId"])
                if (not record or record.get("role") != role or record.get("accountId") != session["accountId"]
                        or not attached
                        or (role == "terminal_data" and record.get("terminalDataEndpoint") != self.data_endpoint)):
                    raise PermissionError("Session connection changed")

        def credentials(side):
            response = self.sts.assume_role(RoleArn=self.role_arn, RoleSessionName="terminal-" + side + "-" + session["terminalId"],
                DurationSeconds=900, Policy=json.dumps(callback_policy(self.data_endpoint, self.role_arn, self.region)))
            values = response["Credentials"]
            return {"accessKeyId": values["AccessKeyId"], "secretAccessKey": values["SecretAccessKey"],
                "sessionToken": values["SessionToken"], "expiresAt": int(values["Expiration"].timestamp())}
        with ThreadPoolExecutor(max_workers=2) as executor:
            results = dict(zip(["app", "bridge"], executor.map(credentials, ["app", "bridge"])))
        expires = min(result["expiresAt"] for result in results.values())
        self.table.update_item(Key={"connectionId": session["connectionId"]},
            UpdateExpression="SET #state = :active, expiresAt = :expires, issuedAt = :now, #ttl = :ttl",
            ConditionExpression="#state = :expected", ExpressionAttributeNames={"#state": "state", "#ttl": "ttl"},
            ExpressionAttributeValues={":active": "active", ":expected": expected_state, ":expires": expires,
                ":now": int(time.time()), ":ttl": expires + 120})
        for side, peer in [("bridge", "app"), ("app", "bridge")]:
            if self.notify(session[side + "Control"], session, "ready", side=side,
                    connectionId=session[side + "Data"], peerConnectionId=session[peer + "Data"],
                    endpoint=self.data_endpoint, region=self.region, credentials=results[side], frameKey=session["frameKey"]) is False:
                self.close(session["terminalId"])
                return

    def control(self, body, connection, connection_id):
        session = self.get(session_key(body["terminalId"]))
        if (not session or session.get("accountId") != connection.get("accountId")
                or connection_id not in [session["appControl"], session["bridgeControl"]]):
            raise PermissionError("Session control owner mismatch")
        if body["op"] == "close":
            reason = body.get("reason")
            if connection_id == session["bridgeControl"] and isinstance(reason, str) and 0 < len(reason) <= 256:
                self.close(session["terminalId"], reason)
            else:
                self.close(session["terminalId"])
            return
        if connection_id != session["appControl"] or session.get("state") != "active":
            raise PermissionError("Only the active app can renew credentials")
        if session.get("issuedAt", 0) + 60 > time.time():
            return
        if session.get("expiresAt", 0) <= time.time():
            self.close(session["terminalId"], "Terminal authorization expired. Reconnect.")
            return
        try:
            self.issue(session, "active")
        except Exception:
            self.close(session["terminalId"], "Terminal authorization renewal failed. Reconnect.")
            raise


def service(endpoint, table, query, post, disconnect):
    global _sts
    role_arn = os.environ.get("TERMINAL_DIRECT_ROLE_ARN")
    if not role_arn:
        raise ValueError("Direct terminal transport is not deployed.")
    region = os.environ.get("AWS_REGION", "ap-northeast-1")
    if _sts is None:
        _sts = boto3.client("sts", region_name=region)
    return DirectSessions(table, query, post, disconnect, os.environ["WS_API_ENDPOINT"], role_arn, region, _sts,
        os.environ["TERMINAL_DIRECT_ENDPOINT"])


def handle_terminal_direct(body, connection, connection_id, endpoint, *, table, query, post, disconnect):
    terminal_id = body.get("terminalId")
    if (body.get("v") != 1 or not isinstance(terminal_id, str) or not UUID.fullmatch(terminal_id)
            or len(json.dumps(body).encode()) > 8192 or body.get("op") not in ["open", "join", "renew", "close"]):
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
        message, status = "Invalid terminal authorization or session connection mismatch.", 403
    except (ValueError, ClientError) as error:
        message = str(error) if isinstance(error, ValueError) else "Terminal busy or authorization unavailable. Reconnect."
        status = 400
    except Exception:
        message, status = "Terminal initialization failed. Reconnect.", 500
    post(endpoint, connection_id, {"action": "terminal_direct", "v": 1, "type": "error",
        "terminalId": terminal_id, "message": message})
    return {"statusCode": status}


def terminal_direct_disconnect(connection, endpoint, *, table, query, post, disconnect):
    connection = connection or {}
    terminal_ids = set(connection.get("terminalDirectIds", set()))
    if connection.get("terminalDirectId"):
        terminal_ids.add(connection["terminalDirectId"])
    for terminal_id in terminal_ids:
        if isinstance(terminal_id, str) and UUID.fullmatch(terminal_id):
            service(endpoint, table, query, post, disconnect).close(terminal_id)
