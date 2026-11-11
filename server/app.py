#!/usr/bin/env python3
"""Oasis-spaces server: serves the static site and a small JSON/SSE API.

    python3 server/app.py            # http://localhost:8735

Standard library only. Endpoints:
    GET  /api/presets      sample rooms
    POST /api/analyze      metrics, collisions, walkability, cost
    POST /api/arrange      auto-layout, streamed as Server-Sent Events
    GET  /health           {"status":"ok"}
"""
import gzip
import hashlib
import json
import mimetypes
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

sys.path.insert(0, str(Path(__file__).parent))
import planner  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
MAX_BODY = 64 * 1024
HIDDEN = {"server", "tests", ".git"}
ALLOWED = {".html", ".js", ".css", ".png", ".json", ".webmanifest", ".svg", ".ico", ""}
CSP = ("default-src 'self'; script-src 'self' https://cdn.jsdelivr.net; "
       "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
       "font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self' https://cdn.jsdelivr.net; "
       "frame-ancestors 'none'; base-uri 'self'")


class RateLimiter:
    """Token bucket per client address."""

    def __init__(self, rate=10.0, burst=30):
        self.rate, self.burst, self.b, self.lock = rate, burst, {}, threading.Lock()

    def allow(self, key):
        now = time.monotonic()
        with self.lock:
            tokens, last = self.b.get(key, (self.burst, now))
            tokens = min(self.burst, tokens + (now - last) * self.rate)
            ok = tokens >= 1
            self.b[key] = (tokens - 1 if ok else tokens, now)
            if len(self.b) > 5000:
                self.b.clear()
            return ok


LIMIT = RateLimiter()


class Handler(BaseHTTPRequestHandler):
    server_version = "Oasis"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *a):
        if os.environ.get("OASIS_QUIET") != "1":
            super().log_message(fmt, *a)

    # ------------------------------------------------------------ helpers
    def _send(self, status, body: bytes, ctype, extra=None):
        h = {"Content-Type": ctype, "X-Content-Type-Options": "nosniff",
             "Referrer-Policy": "same-origin", "Content-Security-Policy": CSP}
        h.update(extra or {})
        if "gzip" in self.headers.get("Accept-Encoding", "") and len(body) > 1024 \
                and ctype.split("/")[0] in ("text", "application"):
            body = gzip.compress(body, 5)
            h["Content-Encoding"] = "gzip"
        h["Vary"] = "Accept-Encoding"
        self.send_response(status)
        h["Content-Length"] = str(len(body))
        for k, v in h.items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, status, obj, extra=None):
        h = {"Cache-Control": "no-store"}
        h.update(extra or {})
        self._send(status, json.dumps(obj).encode(), "application/json", h)

    def _body(self):
        try:
            n = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            n = -1
        if not 0 < n <= MAX_BODY:
            raise planner.ValidationError(f"body must be 1..{MAX_BODY} bytes")
        try:
            return json.loads(self.rfile.read(n))
        except (json.JSONDecodeError, UnicodeDecodeError):
            raise planner.ValidationError("body is not valid JSON")

    def _limited(self):
        if LIMIT.allow(self.client_address[0]):
            return False
        self._json(429, {"error": "slow down"}, {"Retry-After": "1"})
        return True

    # ------------------------------------------------------------- routes
    def do_GET(self):
        self._get()

    def do_HEAD(self):
        self._get()

    def _get(self):
        path = urlparse(self.path).path
        if path in ("/health", "/health.json"):
            return self._json(200, {"status": "ok"})
        if path == "/api/presets":
            return self._json(200, planner.PRESETS)
        if path.startswith("/api/"):
            return self._json(404, {"error": "not found"})
        self._static(path)

    def do_POST(self):
        path = urlparse(self.path).path
        if path not in ("/api/analyze", "/api/arrange"):
            return self._json(404, {"error": "not found"})
        if self._limited():
            return
        try:
            data = self._body()
            if path == "/api/analyze":
                return self._json(200, planner.analyze(data))
            events = planner.arrange(data)
            first = next(events)  # surfaces validation errors before streaming starts
        except planner.ValidationError as e:
            return self._json(400, {"error": str(e)})
        self.close_connection = True
        self.send_response(200)
        for k, v in {"Content-Type": "text/event-stream", "Cache-Control": "no-store",
                     "Connection": "close", "X-Content-Type-Options": "nosniff"}.items():
            self.send_header(k, v)
        self.end_headers()
        try:
            for ev in [first, *events]:
                self.wfile.write(f"data: {json.dumps(ev)}\n\n".encode())
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _static(self, path):
        rel = Path(path.lstrip("/"))
        if path.endswith("/") or not rel.name:
            rel = rel / "index.html"
        target = (ROOT / rel).resolve()
        parts = target.relative_to(ROOT).parts if ROOT in target.parents or target == ROOT else None
        ok = (parts and not (set(parts) & HIDDEN) and not any(p.startswith(".") for p in parts)
              and target.suffix in ALLOWED)
        if ok and target.is_dir():
            target = target / "index.html"
        if not ok or not target.is_file():
            nf = ROOT / "404.html"
            body = nf.read_bytes() if nf.exists() else b"Not found"
            return self._send(404, body, "text/html; charset=utf-8")
        body = target.read_bytes()
        etag = '"%s"' % hashlib.sha1(body).hexdigest()[:16]
        if self.headers.get("If-None-Match") == etag:
            self.send_response(304)
            self.send_header("ETag", etag)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        ctype = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype.endswith("javascript"):
            ctype += "; charset=utf-8"
        self._send(200, body, ctype, {"ETag": etag, "Cache-Control": "no-cache"})


def make_server(host="127.0.0.1", port=8735):
    ThreadingHTTPServer.daemon_threads = True
    return ThreadingHTTPServer((host, port), Handler)


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8735"))
    srv = make_server(os.environ.get("HOST", "127.0.0.1"), port)
    print(f"Oasis-spaces on http://localhost:{port}  (planner at /planner/)")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
