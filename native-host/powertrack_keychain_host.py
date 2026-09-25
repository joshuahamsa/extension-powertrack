#!/usr/bin/python3
"""Native messaging host: save the captured PowerTrack session to the macOS Keychain.

The PowerTrack Assistant extension sends {"cookie": ..., "ae_s": ...} whenever it
sees a new session. This host writes them to Keychain items `powertrack-cookie`
and `powertrack-ae-s` (account `powertrack`) so scripts can use the session
without copying it by hand. Values go to `security` over stdin, never argv, and
are never echoed back or logged.
"""

import json
import struct
import subprocess
import sys

ACCOUNT = "powertrack"
SERVICES = ("powertrack-cookie", "powertrack-ae-s")
MAX_MESSAGE_BYTES = 64 * 1024
MAX_FIELD_CHARS = 16 * 1024


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
    return _field(msg, "cookie"), _field(msg, "ae_s")


def _quote(value):
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


def store(cookie, ae_s, runner=subprocess.run):
    commands = "".join(
        "add-generic-password -U -a {0} -s {1} -w {2}\n".format(ACCOUNT, service, _quote(value))
        for service, value in zip(SERVICES, (cookie, ae_s))
    )
    result = runner(["/usr/bin/security", "-i"], input=commands, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError("security exited with {0}".format(result.returncode))


def handle(msg, runner=subprocess.run):
    try:
        cookie, ae_s = validate(msg)
        store(cookie, ae_s, runner=runner)
    except (ValueError, RuntimeError) as exc:
        return {"ok": False, "error": str(exc)}
    return {"ok": True}


def main():
    stdin, stdout = sys.stdin.buffer, sys.stdout.buffer
    while True:
        try:
            msg = read_message(stdin)
        except ValueError as exc:
            write_message(stdout, {"ok": False, "error": str(exc)})
            return
        if msg is None:
            return
        write_message(stdout, handle(msg))


if __name__ == "__main__":
    main()
