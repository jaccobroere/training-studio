"""The pyrunner service: POST /run {code, data} → result. Reachable only from `app` on an
internal network; it holds no secrets and no database."""

from __future__ import annotations

import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from pyrunner.execute import LIMITS, become_reaper, run_job


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        self._send(200, {"ok": True, "limits": LIMITS}) if self.path == "/health" else self._send(404, {})

    def do_POST(self):
        if self.path != "/run":
            return self._send(404, {})
        n = int(self.headers.get("content-length") or 0)
        if n > LIMITS["max_input_mb"] * 1024 * 1024:
            return self._send(413, {"error": "too large"})
        try:
            job = json.loads(self.rfile.read(n))
            self._send(200, run_job(str(job["code"]), dict(job.get("data") or {})))
        except (ValueError, KeyError) as e:
            self._send(400, {"error": str(e)[:200]})

    def _send(self, code: int, body: dict):
        raw = json.dumps(body, default=str).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def log_message(self, *a):  # no request logging: payloads are health data
        pass


if __name__ == "__main__":
    become_reaper()
    ThreadingHTTPServer(("0.0.0.0", 8090), Handler).serve_forever()
