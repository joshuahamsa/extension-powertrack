import io
import json
import struct
import unittest

import powertrack_keychain_host as host


def frame(obj):
    body = json.dumps(obj).encode("utf-8")
    return struct.pack("<I", len(body)) + body


class FakeRunner:
    def __init__(self, returncodes=(0,)):
        self.calls = []
        self.returncodes = list(returncodes)

    def __call__(self, cmd, capture_output, text):
        self.calls.append(cmd)

        class Result:
            pass

        r = Result()
        r.returncode = self.returncodes.pop(0) if len(self.returncodes) > 1 else self.returncodes[0]
        r.stdout = ""
        r.stderr = ""
        return r


class MessageFramingTests(unittest.TestCase):
    def test_reads_length_prefixed_json(self):
        stream = io.BytesIO(frame({"cookie": "c=1", "ae_s": "abc"}))
        self.assertEqual(host.read_message(stream), {"cookie": "c=1", "ae_s": "abc"})

    def test_read_returns_none_on_eof(self):
        self.assertIsNone(host.read_message(io.BytesIO(b"")))

    def test_rejects_oversized_message(self):
        stream = io.BytesIO(struct.pack("<I", host.MAX_MESSAGE_BYTES + 1))
        with self.assertRaises(ValueError):
            host.read_message(stream)

    def test_writes_length_prefixed_json(self):
        out = io.BytesIO()
        host.write_message(out, {"ok": True})
        raw = out.getvalue()
        (length,) = struct.unpack("<I", raw[:4])
        self.assertEqual(json.loads(raw[4 : 4 + length]), {"ok": True})


class ValidationTests(unittest.TestCase):
    def test_accepts_cookie_and_ae_s(self):
        self.assertEqual(host.validate({"cookie": "a=1; b=2", "ae_s": "xyz", "extra": 1}), ("a=1; b=2", "xyz", None))

    def test_accepts_optional_ae_v(self):
        self.assertEqual(host.validate({"cookie": "a=1", "ae_s": "xyz", "ae_v": "090000"}), ("a=1", "xyz", "090000"))

    def test_rejects_missing_or_empty_fields(self):
        for msg in ({}, {"cookie": "a=1"}, {"cookie": "", "ae_s": "x"}, {"cookie": "a", "ae_s": 5}):
            with self.assertRaises(ValueError):
                host.validate(msg)

    def test_rejects_newlines(self):
        with self.assertRaises(ValueError):
            host.validate({"cookie": "a=1\nadd-generic-password", "ae_s": "x"})


class StoreTests(unittest.TestCase):
    def test_writes_each_item_with_update_flag(self):
        runner = FakeRunner()
        long_cookie = "a=" + "x" * 5000 + '; b="q"'
        host.store(long_cookie, "s\\t", runner=runner)
        self.assertEqual(
            runner.calls,
            [
                ["/usr/bin/security", "add-generic-password", "-U", "-a", "powertrack", "-s", "powertrack-cookie", "-w", long_cookie],
                ["/usr/bin/security", "add-generic-password", "-U", "-a", "powertrack", "-s", "powertrack-ae-s", "-w", "s\\t"],
            ],
        )

    def test_stores_ae_v_when_given(self):
        runner = FakeRunner()
        host.store("a=1", "x", "090000", runner=runner)
        self.assertEqual(runner.calls[-1][-3:], ["powertrack-ae-v", "-w", "090000"])

    def test_retries_once_on_duplicate_item_race(self):
        runner = FakeRunner(returncodes=(45, 0, 0))
        host.store("a=1", "x", runner=runner)
        self.assertEqual(len(runner.calls), 3)

    def test_raises_when_security_fails(self):
        with self.assertRaises(RuntimeError):
            host.store("a=1", "x", runner=FakeRunner(returncodes=(1,)))


class HandleTests(unittest.TestCase):
    def test_success_response_never_echoes_values(self):
        runner = FakeRunner()
        resp = host.handle({"cookie": "secretcookie", "ae_s": "secretaes"}, runner=runner)
        self.assertEqual(resp, {"ok": True})

    def test_error_response_never_echoes_values(self):
        resp = host.handle({"cookie": "secret\ncookie", "ae_s": "x"}, runner=FakeRunner())
        self.assertFalse(resp["ok"])
        self.assertNotIn("secret", json.dumps(resp))


if __name__ == "__main__":
    unittest.main()
