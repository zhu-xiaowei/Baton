import hashlib
import hmac
import json
import os
import secrets
import time
import uuid

import boto3
from botocore.exceptions import ClientError

from terminal_direct_ws import callback_policy


def enabled():
    return os.environ.get("REALTIME_DIRECT_ENABLED") == "1"


class RealtimeDirect:
    def __init__(self, table, query, post, disconnect, targets, endpoint):
        self.table = table
        self.query = query
        self.post = post
        self.disconnect = disconnect
        self.targets = targets
        self.endpoint = os.environ.get("WS_API_ENDPOINT", endpoint)
        self.data_endpoint = os.environ.get("TERMINAL_DIRECT_ENDPOINT", "")

    def get(self, connection_id):
        return self.table.get_item(Key={"connectionId": connection_id}, ConsistentRead=True).get("Item")

    def notify(self, connection_id, kind, **fields):
        return self.post(self.endpoint, connection_id, {"action": "realtime_direct", "v": 1, "type": kind, **fields})

    def invalidate(self, account_id, sessions):
        for bridge in self.query(account_id, "bridge"):
            if bridge.get("realtimeVersion") == 1:
                for session_id in sessions:
                    self.notify(bridge["connectionId"], "invalidate", sessionId=session_id)

    def subscription(self, connection_id, account_id, session_id, remove=False):
        connection = self.get(connection_id)
        if not connection or (session_id in connection.get("realtimeSessions", set())) == (not remove):
            return
        self.table.update_item(Key={"connectionId": connection_id},
            UpdateExpression=("DELETE" if remove else "ADD") + " realtimeSessions :sessions",
            ConditionExpression="attribute_exists(connectionId)",
            ExpressionAttributeValues={":sessions": {session_id}})
        self.invalidate(account_id, [session_id])

    def close(self, connection, publish=True):
        if not connection:
            return
        if connection.get("role") == "realtime_data":
            control = self.get(connection.get("realtimeControlId", "")) if connection.get("realtimeControlId") else None
            if not control or control.get("realtimeDataId") != connection["connectionId"]:
                return
        elif connection.get("role") == "app":
            control = connection
        else:
            return
        binding = control.get("realtimeBindingId")
        if binding:
            try:
                self.table.update_item(Key={"connectionId": control["connectionId"]},
                    UpdateExpression="REMOVE realtimeDataId, realtimeBindingId, realtimeFrameKey, realtimeJoinHash, realtimeJoinExpires",
                    ConditionExpression="realtimeBindingId = :binding", ExpressionAttributeValues={":binding": binding})
            except ClientError as error:
                if error.response["Error"]["Code"] == "ConditionalCheckFailedException":
                    return
                raise
            data_id = control.get("realtimeDataId")
            if data_id and connection.get("role") != "realtime_data":
                self.disconnect(self.data_endpoint, data_id)
            self.notify(control["connectionId"], "closed", bindingId=binding, requestId=control.get("realtimeRequestId"))
        if publish:
            self.invalidate(control["accountId"], control.get("realtimeSessions", set()))

    def handle(self, body, connection, connection_id):
        request_id = body.get("requestId", "")
        if not enabled():
            return self.notify(connection_id, "unsupported", requestId=request_id)
        if not self.data_endpoint or self.data_endpoint == self.endpoint or body.get("v") != 1:
            raise ValueError("Invalid realtime endpoint")
        operation = body.get("op")
        role = connection.get("role")
        if operation == "hello" and role == "bridge":
            role_arn = os.environ["TERMINAL_DIRECT_ROLE_ARN"]
            region = os.environ["AWS_REGION"]
            result = boto3.client("sts", region_name=region).assume_role(RoleArn=role_arn,
                RoleSessionName="realtime-" + uuid.uuid4().hex[:20], DurationSeconds=900,
                Policy=json.dumps(callback_policy(self.data_endpoint, role_arn, region)))
            credentials = result["Credentials"]
            return self.notify(connection_id, "credentials", endpoint=self.data_endpoint, region=region,
                credentials={"accessKeyId": credentials["AccessKeyId"], "secretAccessKey": credentials["SecretAccessKey"],
                    "sessionToken": credentials["SessionToken"], "expiresAt": int(credentials["Expiration"].timestamp())})
        if operation == "open" and role == "app":
            if not isinstance(request_id, str) or not 1 <= len(request_id) <= 64:
                raise ValueError("Invalid realtime request")
            self.close(connection)
            binding, token, frame_key = str(uuid.uuid4()), secrets.token_hex(32), secrets.token_hex(32)
            self.table.update_item(Key={"connectionId": connection_id},
                UpdateExpression="SET realtimeBindingId = :binding, realtimeJoinHash = :token, realtimeFrameKey = :key, realtimeJoinExpires = :expires, realtimeRequestId = :request REMOVE realtimeDataId",
                ConditionExpression="attribute_exists(connectionId)",
                ExpressionAttributeValues={":binding": binding, ":token": hashlib.sha256(token.encode()).hexdigest(),
                    ":key": frame_key, ":expires": int(time.time()) + 45, ":request": request_id})
            return self.notify(connection_id, "offer", requestId=request_id, bindingId=binding,
                controlId=connection_id, joinToken=token, endpoint=self.data_endpoint)
        if operation == "join" and role == "realtime_data":
            control_id = body.get("controlId")
            token = body.get("joinToken")
            if not isinstance(control_id, str) or not isinstance(token, str) or len(token) != 64:
                raise ValueError("Invalid realtime join")
            control = self.get(control_id)
            if (not control or control.get("role") != "app" or control.get("accountId") != connection.get("accountId")
                    or control.get("realtimeBindingId") != body.get("bindingId")
                    or control.get("realtimeJoinExpires", 0) < time.time()
                    or connection.get("terminalDataEndpoint") != self.data_endpoint
                    or not hmac.compare_digest(control.get("realtimeJoinHash", ""), hashlib.sha256(token.encode()).hexdigest())):
                raise ValueError("Realtime join denied")
            self.table.update_item(Key={"connectionId": connection_id},
                UpdateExpression="SET realtimeControlId = :control, realtimeBindingId = :binding",
                ConditionExpression="attribute_exists(connectionId)",
                ExpressionAttributeValues={":control": control_id, ":binding": body["bindingId"]})
            self.table.update_item(Key={"connectionId": control_id},
                UpdateExpression="SET realtimeDataId = :data REMOVE realtimeJoinHash, realtimeJoinExpires",
                ConditionExpression="realtimeBindingId = :binding AND realtimeJoinHash = :token",
                ExpressionAttributeValues={":data": connection_id, ":binding": body["bindingId"], ":token": control["realtimeJoinHash"]})
            if self.notify(control_id, "ready", requestId=control["realtimeRequestId"],
                    bindingId=body["bindingId"], frameKey=control["realtimeFrameKey"]) is False:
                self.disconnect(self.data_endpoint, connection_id)
                return
            return self.invalidate(control["accountId"], control.get("realtimeSessions", set()))
        if operation == "resolve" and role == "bridge":
            session_id = body.get("sessionId")
            if not isinstance(session_id, str) or not 1 <= len(session_id) <= 512 or not isinstance(request_id, str) or len(request_id) > 64:
                raise ValueError("Invalid realtime subscription")
            result = []
            for target_id in self.targets(body, connection["accountId"], connection_id):
                target = self.get(target_id)
                if not target or target.get("role") != "app" or target.get("accountId") != connection["accountId"]:
                    continue
                record = {"controlId": target_id}
                data = self.get(target["realtimeDataId"]) if target.get("realtimeDataId") else None
                if (data and data.get("role") == "realtime_data" and data.get("accountId") == connection["accountId"]
                        and data.get("realtimeControlId") == target_id
                        and data.get("realtimeBindingId") == target.get("realtimeBindingId")):
                    record.update(dataId=data["connectionId"], bindingId=target["realtimeBindingId"], frameKey=target["realtimeFrameKey"])
                result.append(record)
            if len(json.dumps(result).encode()) > 24000:
                return self.notify(connection_id, "targets", requestId=request_id, useLambda=True)
            return self.notify(connection_id, "targets", requestId=request_id, targets=result)
        raise ValueError("Realtime operation denied")


def handle_realtime_direct(body, connection, connection_id, service):
    try:
        if len(json.dumps(body).encode()) > 8192:
            raise ValueError("Oversized realtime control")
        service.handle(body, connection, connection_id)
        return {"statusCode": 200}
    except Exception:
        if connection.get("role") == "realtime_data":
            service.disconnect(service.data_endpoint, connection_id)
        else:
            service.notify(connection_id, "error", requestId=body.get("requestId", ""))
        return {"statusCode": 400}
