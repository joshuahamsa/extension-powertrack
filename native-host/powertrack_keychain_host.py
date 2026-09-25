#!/usr/bin/python3
"""Native messaging host: save the captured PowerTrack session to the macOS Keychain.

The PowerTrack Assistant extension sends {"cookie": ..., "ae_s": ...} whenever it
sees a new session. This host writes them to Keychain items `powertrack-cookie`
and `powertrack-ae-s` (account `powertrack`) so scripts can use the session
without copying it by hand. Values are never echoed back or logged.

They are passed to `security` as an argument: `security -i` truncates lines at
4096 bytes and `-w` on stdin truncates at 128 characters, and the cookie is
longer than both. The argument is visible to local process listings only while
`security` runs, and the same cookie is already readable from the browser's
own cookie store by any process running as this user.
"""

import json
import os
import struct
import subprocess
import sys
import time

ACCOUNT = "powertrack"
SERVICES = ("powertrack-cookie", "powertrack-ae-s")
AE_V_SERVICE = "powertrack-ae-v"
MAX_MESSAGE_BYTES = 256 * 1024
MAX_FIELD_CHARS = 64 * 1024  # observed cookies are ~14K characters
LOG_PATH = os.path.expanduser("~/Library/Logs/powertrack_keychain_host.log")


def read_message(stream):
    header = stream.read(4)
    if len(header) < 4:
        return None
    (length,) = struct.unpack("<I", header)
    if length > MAX_MESSAGE_BYTES:
        raise ValueError("message too large")
    return json.loads(stream.read(length).decode("utf-8"))


def write_message(stream, obj):
    body = json.dumps(obj).encode("utf-8")
    stream.write(struct.pack("<I", len(body)) + body)
    stream.flush()


def _field(msg, name):
    value = msg.get(name)
    if not isinstance(value, str) or not value or len(value) > MAX_FIELD_CHARS:
        raise ValueError("{0} missing or invalid".format(name))
    if "\n" in value or "\r" in value or "\x00" in value:
        raise ValueError("{0} contains invalid characters".format(name))
    return value


def validate(msg):
    if not isinstance(msg, dict):
        raise ValueError("message must be an object")
    ae_v = _field(msg, "ae_v") if msg.get("ae_v") is not None else None
    return _field(msg, "cookie"), _field(msg, "ae_s"), ae_v


ERR_DUPLICATE_ITEM = 45  # concurrent create of the same item; retry as update


def store(cookie, ae_s, ae_v=None, runner=subprocess.run):
    items = list(zip(SERVICES, (cookie, ae_s)))
    if ae_v is not None:
        items.append((AE_V_SERVICE, ae_v))
    for service, value in items:
        cmd = ["/usr/bin/security", "add-generic-password", "-U", "-a", ACCOUNT, "-s", service, "-w", value]
        result = runner(cmd, capture_output=True, text=True)
        if result.returncode == ERR_DUPLICATE_ITEM:
            result = runner(cmd, capture_output=True, text=True)
        if result.returncode != 0:
            raise RuntimeError("security exited with {0} for {1}".format(result.returncode, service))


def handle(msg, runner=subprocess.run):
    try:
        cookie, ae_s, ae_v = validate(msg)
        store(cookie, ae_s, ae_v, runner=runner)
    except (ValueError, RuntimeError) as exc:
        return {"ok": False, "error": str(exc)}
    return {"ok": True}


def log(event):
    """Append a status line. Never pass session values here."""
    try:
        with open(LOG_PATH, "a", encoding="utf-8") as f:
            f.write("{0} {1}\n".format(time.strftime("%Y-%m-%dT%H:%M:%S"), event))
    except OSError:
        pass


def main():
    log("started")
    stdin, stdout = sys.stdin.buffer, sys.stdout.buffer
    while True:
        try:
            msg = read_message(stdin)
        except ValueError as exc:
            log("error: {0}".format(exc))
            write_message(stdout, {"ok": False, "error": str(exc)})
            return
        if msg is None:
            return
        response = handle(msg)
        log("saved" if response["ok"] else "error: {0}".format(response["error"]))
        write_message(stdout, response)


if __name__ == "__main__":
    main()
