"""The deployment's single API key, read from API Gateway so it is never stored in a table."""

import hashlib
import hmac
import os
import time

import boto3

CACHE_SECONDS = 300

_cached = (0, None)


def key_name():
    return os.environ.get("API_KEY_NAME", "")


def current_key():
    global _cached
    if _cached[0] > time.time():
        return _cached[1]
    name = key_name()
    client = boto3.client("apigateway", region_name=os.environ.get("AWS_REGION", "us-east-1"))
    items = client.get_api_keys(nameQuery=name, includeValues=True, limit=500).get("items", [])
    value = next((item["value"] for item in items if item.get("name") == name and item.get("enabled")), None)
    # A missing key is not cached: during rotation the new key may appear after this Lambda updates.
    if value:
        _cached = (time.time() + CACHE_SECONDS, value)
    return value


def is_current(key):
    current = current_key()
    return bool(key and current) and hmac.compare_digest(key.encode(), current.encode())


def account_id(key):
    # Pinned at deploy (install.sh), so rotating the key keeps the same data.
    return os.environ.get("ACCOUNT_ID") or hashlib.sha256(key.encode()).hexdigest()[:16]
