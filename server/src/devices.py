"""Device rows in SystemTable: each Bridge connection writes its own; /devices and the install
script's name check read them; removing a device deletes it."""

import os
import time

import boto3
from boto3.dynamodb.conditions import Key

_table = None


def _devices():
    global _table
    if _table is None:
        _table = boto3.resource("dynamodb").Table(os.environ["SYSTEM_TABLE"])
    return _table


def _pk(account_id):
    return f"DEVICE#{account_id}"


def put_device(account_id, device, display_name="", os_name=""):
    _devices().put_item(Item={
        "pk": _pk(account_id),
        "sk": device,
        "deviceName": device,
        "deviceDisplayName": (display_name or device)[:64],
        "os": os_name[:16],
        "lastConnected": int(time.time()),
    })


def list_devices(account_id):
    kwargs = {"KeyConditionExpression": Key("pk").eq(_pk(account_id))}
    items = []
    while True:
        response = _devices().query(**kwargs)
        items.extend(response.get("Items", []))
        if "LastEvaluatedKey" not in response:
            return items
        kwargs["ExclusiveStartKey"] = response["LastEvaluatedKey"]


def delete_device(account_id, device):
    _devices().delete_item(Key={"pk": _pk(account_id), "sk": device})
