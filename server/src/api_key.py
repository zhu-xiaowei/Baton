"""The deployment's single API key, read from API Gateway so it is never stored in a table."""

import hashlib
import hmac
import os
import time

import boto3

CACHE_SECONDS = 300

_cached = (0, None)


class KeyUnavailable(Exception):
    """The deployment key could not be read, so a key can be neither accepted nor rejected."""


def key_name():
    return os.environ.get("API_KEY_NAME", "")


def current_key():
    global _cached
    if _cached[0] > time.time():
        return _cached[1]
    name = key_name()
    try:
        client = boto3.client("apigateway", region_name=os.environ.get("AWS_REGION", "us-east-1"))
        items = client.get_api_keys(nameQuery=name, includeValues=True, limit=500).get("items", [])
    except Exception as error:
        print(f"API key lookup failed: {error}")
        if _cached[1]:
            return _cached[1]
        raise KeyUnavailable() from error
    value = next((item["value"] for item in items if item.get("name") == name and item.get("enabled")), None)
    # During rotation this Lambda may update before the new key exists; not cached, so it is retried.
    if not value:
        raise KeyUnavailable()
    _cached = (time.time() + CACHE_SECONDS, value)
    return value


def is_current(key):
    current = current_key()
    return bool(key and current) and hmac.compare_digest(key.encode(), current.encode())


def account_id(key):
    # Pinned at deploy (install.sh) so a rotated key keeps the data; any other key still gets its
    # own empty account, as before pinning. KeyUnavailable propagates (503) rather than guessing,
    # which would split a rotated deployment's data into a second account.
    pinned = os.environ.get("ACCOUNT_ID")
    if pinned and is_current(key):
        return pinned
    return hashlib.sha256(key.encode()).hexdigest()[:16]
