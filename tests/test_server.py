"""Tests for server.py. Standard library only - run from the project folder with:

    python -m unittest discover -s tests -v

Every test runs against a throwaway copy in a temporary folder, with a fake
API key. Your real data/ folder, chats and key are never touched, and nothing
is sent to OpenRouter.
"""
import base64
import http.client
import json
import os
import shutil
import sys
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import server  # noqa: E402

REAL_APP_DIR = server.APP_DIR
FAKE_KEY = "sk-or-v1-TESTKEY-not-real-0000000000000000"
TINY_PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==")


def write(path, content):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(content.encode("utf-8") if isinstance(content, str) else content)


def point_server_at(root):
    """Make every path in server.py point inside `root` instead of the real app folder."""
    data = os.path.join(root, "data")
    server.APP_DIR = root
    server.CHARACTERS_DIR = os.path.join(root, "characters")
    server.CHATS_DIR = os.path.join(root, "chats")
    server.DATA_DIR = data
    server.DB_PATH = os.path.join(data, "app.db")
    server.SETTINGS_PATH = os.path.join(data, "settings.json")
    server.UPLOADS_DIR = os.path.join(data, "media", "uploads")
    server.MEDIA_DIRS = {"image": os.path.join(data, "media", "images"),
                         "video": os.path.join(data, "media", "videos")}


def paths_still_real():
    """Any module-level path that still points at the real app folder (should be none)."""
    leftovers = []
    for name, value in vars(server).items():
        if name.startswith("__"):            # __file__ and friends: Python's own, not app paths
            continue
        values =value.values() if isinstance(value, dict) else [value]
        for v in values:
            if isinstance(v, str) and v.startswith(REAL_APP_DIR):
                leftovers.append(name)
    return leftovers


class HostAllowedTests(unittest.TestCase):
    def test_local_names_and_ip_addresses_pass(self):
        for host in ("localhost", "localhost:8080", "LOCALHOST:8080", "localhost.", "app.localhost:8080",
                     "127.0.0.1", "127.0.0.1:8080", "[::1]:8080", "[::1]", "192.168.1.20:8080",
                     "100.101.102.103:8080", ""):
            with self.subTest(host=host):
                self.assertTrue(server.host_allowed(host))

    def test_other_domain_names_are_refused(self):
        for host in ("attacker.example", "attacker.example:8080", "localhost.attacker.example",
                     "127.0.0.1.nip.io:8080", "evil.localhost.example", "[not-an-ip]:8080"):
            with self.subTest(host=host):
                self.assertFalse(server.host_allowed(host))

    def test_allow_host_names_pass(self):
        with mock.patch.object(server, "EXTRA_HOST_NAMES", {"my-pc.tail1234.ts.net"}):
            self.assertTrue(server.host_allowed("my-pc.tail1234.ts.net:8080"))
            self.assertTrue(server.host_allowed("MY-PC.tail1234.ts.net."))
            self.assertFalse(server.host_allowed("other.tail1234.ts.net"))


class ServerTests(unittest.TestCase):
    """Starts the real request handler on a free port, inside a temporary folder."""

    @classmethod
    def setUpClass(cls):
        cls.saved = {name: getattr(server, name) for name in
                     ("APP_DIR", "CHARACTERS_DIR", "CHATS_DIR", "DATA_DIR", "DB_PATH",
                      "SETTINGS_PATH", "UPLOADS_DIR", "MEDIA_DIRS")}
        cls.root = tempfile.mkdtemp(prefix="charchat-test-")
        point_server_at(cls.root)
        leftovers = paths_still_real()
        if leftovers:      # never run against the real folder
            raise RuntimeError("these paths still point at the real app: %s" % leftovers)

        r = cls.root
        write(os.path.join(r, "index.html"), "<!doctype html><title>CharChat</title>")
        write(os.path.join(r, "server.py"), "# server source")
        write(os.path.join(r, "user.md"), "secret notes about me")
        write(os.path.join(r, "static", "app.js"), "console.log('app')")
        write(os.path.join(r, "lib", "fonts", "fonts.css"), "body{}")
        write(os.path.join(r, "assets", "logo.png"), TINY_PNG)
        write(os.path.join(r, "characters", "ada", "identity.md"), "You are Ada.")
        write(os.path.join(r, "characters", "ada", "user.md"), "private per-character notes")
        write(os.path.join(r, "characters", "ada", "avatar.png"), TINY_PNG)
        write(os.path.join(r, ".git", "config"), "[core]")

        server.ensure_data_dirs()
        server.init_db()
        server.save_settings({"openrouter_key": FAKE_KEY})

        cls.quiet = mock.patch.object(server.Handler, "log_message", lambda *args: None)
        cls.quiet.start()                  # no request log lines in the test output
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        cls.port = cls.httpd.server_address[1]
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls.quiet.stop()
        server._db.close()
        for name, value in cls.saved.items():
            setattr(server, name, value)
        shutil.rmtree(cls.root, ignore_errors=True)

    def request(self, method, path, host=None, headers=None, body=None):
        """Send the path exactly as written (no tidying), like a hand-made attack would."""
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        conn.putrequest(method, path, skip_host=True, skip_accept_encoding=True)
        conn.putheader("Host", host or "localhost:%d" % self.port)
        payload = json.dumps(body).encode("utf-8") if body is not None else None
        for name, value in (headers or {}).items():
            conn.putheader(name, value)
        if payload is not None:
            conn.putheader("Content-Type", "application/json")
            conn.putheader("Content-Length", str(len(payload)))
        conn.endheaders(payload)
        response = conn.getresponse()
        data = response.read()
        conn.close()
        return response.status, dict(response.getheaders()), data

    # ---- only the page's own files are served ----
    def test_page_files_are_served(self):
        for path in ("/", "/?connected=1", "/index.html", "/static/app.js", "/lib/fonts/fonts.css",
                     "/assets/logo.png", "/characters/ada/avatar.png?v=123"):
            with self.subTest(path=path):
                status, _, _ = self.request("GET", path)
                self.assertEqual(status, 200)

    def test_private_files_are_never_served(self):
        paths = ["/data/settings.json", "/%64ata/settings.json", "/DATA/settings.json",
                 "/data%2fsettings.json", "/static/../data/settings.json", "/./data/settings.json",
                 "/x/../data/settings.json", "/assets/../data/settings.json", "/%64ata/app.db",
                 "/user.md", "/server.py", "/.git/config", "/characters/ada/user.md",
                 "/characters/ada/identity.md", "/static/", "/%2e%2e/%2e%2e/Windows/win.ini"]
        for path in paths:
            for method in ("GET", "HEAD"):
                with self.subTest(path=path, method=method):
                    status, _, data = self.request(method, path)
                    self.assertEqual(status, 404)
                    self.assertNotIn(FAKE_KEY.encode(), data)
                    self.assertNotIn(b"secret notes", data)
                    self.assertNotIn(b"private per-character", data)

    # ---- DNS rebinding: foreign host names are refused ----
    def test_foreign_host_is_refused_everywhere(self):
        page = {"X-CharChat": "1"}
        for method, path in (("GET", "/"), ("GET", "/api/settings"), ("GET", "/api/chats/ada"),
                             ("POST", "/api/openrouter/chat"), ("DELETE", "/api/openrouter/key")):
            with self.subTest(method=method, path=path):
                status, _, _ = self.request(method, path, host="attacker.example:%d" % self.port,
                                            headers=page, body={} if method == "POST" else None)
                self.assertEqual(status, 403)
        self.assertEqual(server.load_settings()["openrouter_key"], FAKE_KEY)   # the key survived

    def test_oauth_callback_uses_the_checked_host(self):
        status, _, data = self.request("GET", "/api/openrouter/connect", headers={"X-CharChat": "1"})
        self.assertEqual(status, 200)
        expected = "callback_url=http%3A%2F%2Flocalhost%3A" + str(self.port) + "%2Foauth%2Fcallback"
        self.assertIn(expected, json.loads(data)["url"])

    # ---- requests from other sites can't change anything ----
    def test_changes_need_the_page_header(self):
        status, _, _ = self.request("PUT", "/api/settings", body={"model": "x"})
        self.assertEqual(status, 403)
        status, _, _ = self.request("DELETE", "/api/openrouter/key")
        self.assertEqual(status, 403)
        self.assertEqual(server.load_settings()["openrouter_key"], FAKE_KEY)

    def test_settings_never_return_the_full_key(self):
        status, _, data = self.request("GET", "/api/settings")
        self.assertEqual(status, 200)
        self.assertNotIn(FAKE_KEY.encode(), data)

    # ---- outside files can't act as part of the app ----
    def test_uploaded_pictures_are_sandboxed(self):
        image = "data:image/png;base64," + base64.b64encode(TINY_PNG).decode()
        status, _, data = self.request("POST", "/api/uploads", headers={"X-CharChat": "1"},
                                       body={"image": image})
        self.assertEqual(status, 200)
        status, headers, data = self.request("GET", json.loads(data)["url"])
        self.assertEqual(status, 200)
        self.assertEqual(data, TINY_PNG)
        self.assertEqual(headers.get("Content-Security-Policy"), "sandbox")
        self.assertEqual(headers.get("X-Content-Type-Options"), "nosniff")

    def test_uploads_reject_non_images(self):
        svg = "data:image/svg+xml;base64," + base64.b64encode(b"<svg onload=alert(1)>").decode()
        status, _, _ = self.request("POST", "/api/uploads", headers={"X-CharChat": "1"},
                                    body={"image": svg})
        self.assertEqual(status, 400)

    # ---- a crash inside a request becomes a readable error ----
    def test_unexpected_error_returns_json(self):
        with mock.patch.object(server, "list_characters", side_effect=RuntimeError("boom")), \
                mock.patch("traceback.print_exc"):
            status, headers, data = self.request("GET", "/api/characters")
        self.assertEqual(status, 500)
        self.assertIn("application/json", headers.get("Content-Type", ""))
        self.assertIn("went wrong", json.loads(data)["error"])
        status, _, _ = self.request("GET", "/api/status")          # and the server keeps running
        self.assertEqual(status, 200)

    # ---- names in addresses can't climb out of their folders ----
    def test_bad_names_are_refused(self):
        for path in ("/api/chats/..%2f..%2fdata", "/api/chats/ada/..%2fx", "/api/characters/a%20b/info"):
            with self.subTest(path=path):
                status, _, _ = self.request("GET", path)
                self.assertEqual(status, 400)


class SettingsTests(unittest.TestCase):
    def setUp(self):
        self.saved = server.SETTINGS_PATH
        self.folder = tempfile.mkdtemp(prefix="charchat-settings-")
        server.SETTINGS_PATH = os.path.join(self.folder, "settings.json")

    def tearDown(self):
        server.SETTINGS_PATH = self.saved
        shutil.rmtree(self.folder, ignore_errors=True)

    def test_saves_at_the_same_time_keep_both_changes(self):
        rounds = 150

        def save_many(field, prefix):
            for i in range(rounds):
                server.save_settings({field: "%s-%d" % (prefix, i)})

        threads = [threading.Thread(target=save_many, args=("model", "m")),
                   threading.Thread(target=save_many, args=("ollama_model", "o"))]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        settings = server.load_settings()
        self.assertEqual(settings["model"], "m-%d" % (rounds - 1))
        self.assertEqual(settings["ollama_model"], "o-%d" % (rounds - 1))

    def test_unknown_settings_are_ignored(self):
        server.save_settings({"model": "a/b", "not_a_setting": "x"})
        with open(server.SETTINGS_PATH, encoding="utf-8") as f:
            saved = json.load(f)
        self.assertEqual(saved["model"], "a/b")
        self.assertNotIn("not_a_setting", saved)

    def test_damaged_file_falls_back_to_defaults(self):
        with open(server.SETTINGS_PATH, "w", encoding="utf-8") as f:
            f.write("{not json")
        self.assertEqual(server.load_settings(), server.DEFAULT_SETTINGS)


if __name__ == "__main__":
    unittest.main()
