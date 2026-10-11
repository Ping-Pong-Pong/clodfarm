"""A stand-in for the X API v2 (tests, and the UI's local preview). It checks each call's OAuth 1.0a signature
against KEYS (any other keys get 401) and answers /2/users/me, posting, deleting, lookups, search and media
uploads. Access token "ro-…" is read only. Run it alone: python tests/fake_x.py [port]."""
import base64
import hashlib
import hmac
import json
import sys
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

KEYS = {"api_key": "ck_farm", "api_secret": "cs_farm_secret", "access_token": "1600000000-farmtoken",
        "access_token_secret": "ats_farm_secret", "bearer_token": "AAAAbearer"}
RO = {**KEYS, "access_token": "ro-1600000000-readonly"}
ME = {"id": "1600000000", "username": "jestrfarm", "name": "Jestr Farm", "verified": False,
      "public_metrics": {"followers_count": 42}}
POSTS: dict[str, dict] = {}
MEDIA: list[dict] = []


def _pct(s):
    return urllib.parse.quote(str(s), safe="~")


class FakeX(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, code, body, headers=None):
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _who(self):
        """The keys whose signature this request carries (verified as X does), or None; the app's bearer token reads."""
        auth = self.headers.get("Authorization") or ""
        if auth == f"Bearer {KEYS['bearer_token']}" and self.command == "GET":
            return KEYS
        if not auth.startswith("OAuth "):
            return None
        oauth = {urllib.parse.unquote(k.strip()): urllib.parse.unquote(v.strip().strip('"'))
                 for k, v in (p.split("=", 1) for p in auth[6:].split(","))}
        sig = oauth.pop("oauth_signature", "")
        for keys in (KEYS, RO):
            if oauth.get("oauth_consumer_key") != keys["api_key"] or oauth.get("oauth_token") != keys["access_token"]:
                continue
            u = urllib.parse.urlsplit(self.path)
            pairs = urllib.parse.parse_qsl(u.query, keep_blank_values=True) + list(oauth.items())
            norm = "&".join(f"{k}={v}" for k, v in sorted((_pct(k), _pct(v)) for k, v in pairs))
            host = f"http://{self.headers['Host'].lower()}"
            base = "&".join((self.command, _pct(host + u.path), _pct(norm)))
            key = f"{_pct(keys['api_secret'])}&{_pct(keys['access_token_secret'])}"
            want = base64.b64encode(hmac.new(key.encode(), base.encode(), hashlib.sha1).digest()).decode()
            if hmac.compare_digest(want, sig):
                return keys
        return None

    def _auth(self):
        keys = self._who()
        if not keys:
            self._send(401, {"title": "Unauthorized", "type": "about:blank", "status": 401, "detail": "Unauthorized"})
        return keys

    def do_GET(self):
        keys = self._auth()
        if not keys:
            return
        u = urllib.parse.urlsplit(self.path)
        q = dict(urllib.parse.parse_qsl(u.query))
        lvl = {"x-access-level": "read" if keys is RO else "read-write"}
        if u.path == "/2/users/me":
            return self._send(200, {"data": ME}, lvl)
        if u.path.startswith("/2/users/by/username/"):
            name = u.path.rsplit("/", 1)[1]
            if name.lower() == "nobody":
                return self._send(200, {"errors": [{"detail": "Could not find user with username: [nobody]."}]})
            return self._send(200, {"data": {**ME, "id": "777", "username": name, "name": name.title()}})
        if u.path.endswith("/tweets") or u.path.endswith("/mentions"):
            n = int(q.get("max_results", 10))
            return self._send(200, {"data": [{"id": i, "text": p["text"]} for i, p in POSTS.items()][:n],
                                    "meta": {"result_count": min(n, len(POSTS))}})
        if u.path == "/2/tweets/search/recent":
            if int(q.get("max_results", 10)) < 10:
                return self._send(400, {"errors": [{"message": "max_results must be between 10 and 100"}]})
            hits = [{"id": i, "text": p["text"]} for i, p in POSTS.items() if q.get("query", "").lower() in p["text"].lower()]
            return self._send(200, {"data": hits, "meta": {"result_count": len(hits)}})
        if u.path.startswith("/2/tweets/"):
            pid = u.path.rsplit("/", 1)[1]
            if pid in POSTS:
                return self._send(200, {"data": {"id": pid, **POSTS[pid]}})
            return self._send(200, {"errors": [{"detail": f"Could not find tweet with id: [{pid}]."}]})
        self._send(404, {"title": "Not Found"})

    def do_POST(self):
        keys = self._auth()
        if not keys:
            return
        raw = self.rfile.read(int(self.headers.get("Content-Length") or 0))
        path = urllib.parse.urlsplit(self.path).path
        if keys is RO:
            return self._send(403, {"title": "Forbidden", "detail": "Your client app is not configured with the "
                                    "appropriate oauth1 app permissions for this endpoint."})
        if path == "/2/media/upload":
            ctype = self.headers.get("Content-Type", "")
            if not ctype.startswith("multipart/form-data") or b'name="media_category"' not in raw:
                return self._send(400, {"errors": [{"message": "media and media_category are required"}]})
            mid = str(1900000000 + len(MEDIA))
            MEDIA.append({"id": mid, "size": len(raw), "category": raw.split(b'name="media_category"\r\n\r\n')[1][:11]})
            return self._send(200, {"data": {"id": mid, "media_key": f"3_{mid}", "size": len(raw)}})
        if path == "/2/tweets":
            body = json.loads(raw or b"{}")
            if not body.get("text") and not body.get("media"):
                return self._send(400, {"errors": [{"message": "Your Tweet text is empty."}]})
            if any(p["text"] == body.get("text") for p in POSTS.values()):
                return self._send(403, {"detail": "You are not allowed to create a Tweet with duplicate content."})
            pid = str(1800000000000000000 + len(POSTS))
            POSTS[pid] = body
            return self._send(201, {"data": {"id": pid, "text": body.get("text", "")}})
        if path.endswith("/likes"):
            return self._send(200, {"data": {"liked": True}})
        self._send(404, {"title": "Not Found"})

    def do_DELETE(self):
        if not self._auth():
            return
        pid = self.path.rsplit("/", 1)[1]
        self._send(200, {"data": {"deleted": POSTS.pop(pid, None) is not None}})


def serve(port: int = 0) -> ThreadingHTTPServer:
    return ThreadingHTTPServer(("127.0.0.1", port), FakeX)


if __name__ == "__main__":
    srv = serve(int(sys.argv[1]) if len(sys.argv) > 1 else 8790)
    print(f"fake X API on http://127.0.0.1:{srv.server_address[1]}", flush=True)
    srv.serve_forever()
