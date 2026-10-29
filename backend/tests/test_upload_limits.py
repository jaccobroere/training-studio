"""Upload limits must apply before multipart parsing as well as to the file itself."""

from __future__ import annotations

import asyncio
import io
from types import SimpleNamespace

import pytest
from starlette.datastructures import UploadFile

import db
import main
import upload_limits
from garmin import api


def cap_request(monkeypatch, size):
    monkeypatch.setattr(upload_limits, "MAX_REQUEST_BYTES", size)


def multipart(data=b"ok", extra=b""):
    return (
        b'--test\r\nContent-Disposition: form-data; name="file"; filename="x.fit"\r\n'
        b"Content-Type: application/octet-stream\r\n\r\n" + data + b"\r\n" + extra + b"--test--\r\n"
    )


def raw_request(client, chunks, headers=(), path="/api/garmin/upload"):
    """Exercise real app ASGI receive, including dishonest length and disconnects."""
    consumed, sent = [], []
    messages = iter(chunks)

    async def receive():
        msg = next(messages, {"type": "http.disconnect"})
        consumed.append(msg)
        return msg

    async def send(msg):
        sent.append(msg)

    scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": "POST",
        "scheme": "http",
        "path": path,
        "raw_path": path.encode(),
        "query_string": b"",
        "root_path": "",
        "server": ("testserver", 80),
        "client": ("127.0.0.1", 1234),
        "headers": [
            (b"host", b"testserver"),
            (b"cookie", "; ".join(f"{k}={v}" for k, v in client.cookies.items()).encode()),
        ],
    }
    scope["headers"] += [(b"content-type", b"multipart/form-data; boundary=test"), *headers]
    asyncio.run(main.app(scope, receive, send))
    return next((m["status"] for m in sent if m["type"] == "http.response.start"), None), consumed


def body_chunks(body, size=17):
    return [
        {"type": "http.request", "body": body[i : i + size], "more_body": i + size < len(body)}
        for i in range(0, len(body), size)
    ]


def test_production_file_limit():
    assert api.MAX_UPLOAD == 104857600
    assert upload_limits.MAX_FILE_BYTES == api.MAX_UPLOAD
    assert upload_limits.MAX_REQUEST_BYTES == 105906176


@pytest.mark.parametrize("ext,kind", [("fit", "fit"), ("zip", "archive")])
def test_file_boundary(client, monkeypatch, ext, kind):
    monkeypatch.setattr(api, "MAX_UPLOAD", 8)
    ok = client.post("/api/garmin/upload", files={"file": (f"x.{ext}", b"12345678")})
    assert ok.status_code == 200
    assert ok.json()["kind"] == kind and ok.json()["state"] == "queued"
    before = client.get("/api/imports").json()
    bad = client.post("/api/garmin/upload", files={"file": (f"x.{ext}", b"123456789")})
    assert bad.status_code == 413 and bad.json()["code"] == "too_large"
    assert client.get("/api/imports").json() == before
    assert not list((db.data_dir() / "uploads").glob("*.part"))
    assert len(list((db.data_dir() / "uploads").glob(f"*.{ext}"))) == 1


def test_declared_overflow_never_reads(client, monkeypatch):
    cap_request(monkeypatch, 256)
    status, consumed = raw_request(client, body_chunks(multipart()), [(b"content-length", b"257")])
    assert status == 413, "declared oversized body reached multipart parser"
    assert consumed == [], "oversized declared body was consumed"
    assert client.get("/api/imports").json() == []


@pytest.mark.parametrize(
    "headers", [[], [(b"content-length", b"1")], [(b"transfer-encoding", b"chunked")]]
)
def test_stream_overflow_including_overhead(client, monkeypatch, headers):
    body = multipart(
        b"ok",
        b'--test\r\nContent-Disposition: form-data; name="padding"\r\n\r\n' + b"x" * 300 + b"\r\n",
    )
    cap_request(monkeypatch, len(body) - 1)
    status, _ = raw_request(client, body_chunks(body), headers)
    assert status == 413, "multipart overhead bypassed whole-request limit"
    assert client.get("/api/imports").json() == []
    assert not (db.data_dir() / "uploads").exists()


def test_exact_request_boundary(client, monkeypatch):
    body = multipart()
    cap_request(monkeypatch, len(body))
    status, _ = raw_request(client, body_chunks(body))
    assert status == 200


def test_disconnect_before_parser(client, monkeypatch):
    cap_request(monkeypatch, 256)
    real = upload_limits.tempfile.SpooledTemporaryFile
    opened = []

    def spool(*args, **kwargs):
        f = real(*args, **kwargs)
        opened.append(f)
        return f

    monkeypatch.setattr(upload_limits.tempfile, "SpooledTemporaryFile", spool)
    status, _ = raw_request(
        client,
        [
            {"type": "http.request", "body": multipart()[:100], "more_body": True},
            {"type": "http.disconnect"},
        ],
    )
    assert status is None, "disconnected upload entered parser"
    assert opened and all(f.closed for f in opened)
    assert client.get("/api/imports").json() == []


@pytest.mark.parametrize(
    "error", [RuntimeError("synthetic read interruption"), asyncio.CancelledError()]
)
def test_interrupted_file_copy_removes_only_part(client, error):
    class Interrupted(UploadFile):
        async def read(self, size=-1):
            if self.file.tell():
                raise error
            return self.file.read(1)

    up = db.data_dir() / "uploads"
    up.mkdir(exist_ok=True)
    existing = up / "existing.fit"
    existing.write_bytes(b"keep")
    request = SimpleNamespace(scope={"state": {"user_id": db.user_id()}})
    with pytest.raises(type(error)):
        asyncio.run(api.upload(Interrupted(io.BytesIO(b"xx"), filename="x.fit"), request, None))
    assert not list(up.glob("*.part")), "interrupted copy left partial upload"
    assert existing.read_bytes() == b"keep"
    assert client.get("/api/imports").json() == []


@pytest.mark.parametrize(
    "outcome", ["ok", "overflow", "disconnect", "parser_error", "receive_error"]
)
def test_staging_disk_cleanup(client, monkeypatch, outcome):
    opened = []
    real = upload_limits.tempfile.SpooledTemporaryFile

    def spool(*args, **kwargs):
        f = real(*args, **kwargs)
        opened.append(f)
        return f

    monkeypatch.setattr(upload_limits, "CHUNK_BYTES", 32)
    monkeypatch.setattr(upload_limits.tempfile, "SpooledTemporaryFile", spool)
    body = multipart(b"x" * 50)
    if outcome == "parser_error":
        body = b"bad multipart" + b"x" * 80
    cap_request(monkeypatch, len(body) - (1 if outcome == "overflow" else 0))
    chunks = body_chunks(body, 40)
    if outcome == "disconnect":
        chunks = chunks[:1] + [{"type": "http.disconnect"}]
    if outcome == "receive_error":
        # A transport exception/cancellation must close an already disk-rolled stage.
        async def receive():
            if not opened:
                return chunks[0]
            if opened[0].tell() == 0:
                return chunks[0]
            raise asyncio.CancelledError()

        async def send(_message):
            raise AssertionError("no response expected")

        scope = {"type": "http", "method": "POST", "path": "/api/garmin/upload", "headers": []}
        with pytest.raises(asyncio.CancelledError):
            asyncio.run(upload_limits.UploadBodyGuard(None)(scope, receive, send))
    else:
        status, _ = raw_request(client, chunks)
        assert (
            status == {"ok": 200, "overflow": 413, "disconnect": None, "parser_error": 400}[outcome]
        )
    assert opened and all(f.closed for f in opened)
    assert opened[0]._rolled, "test must exercise disk spooling, not only memory"
    if outcome != "ok":
        assert client.get("/api/imports").json() == []


def test_auth_precedes_body_guard(anon, monkeypatch):
    cap_request(monkeypatch, 1)
    status, consumed = raw_request(anon, body_chunks(multipart()), [(b"content-length", b"999")])
    assert status == 401 and consumed == []


def test_cross_origin_precedes_body_guard(client, monkeypatch):
    cap_request(monkeypatch, 1)
    status, consumed = raw_request(
        client,
        body_chunks(multipart()),
        [(b"content-length", b"999"), (b"origin", b"https://other.test")],
    )
    assert status == 403 and consumed == []


def test_other_garmin_routes_unaffected(client, monkeypatch):
    cap_request(monkeypatch, 1)
    assert client.get("/api/garmin/status").status_code == 200
    assert client.post("/api/garmin/sync", json={}).status_code == 409


def test_uploads_are_tenant_isolated(client):
    from conftest import signup

    first = client.post("/api/garmin/upload", files={"file": ("x.fit", b"one")}).json()["id"]
    client.post("/api/auth/logout")
    signup(client, "second")
    assert client.get("/api/imports").json() == []
    assert client.get(f"/api/imports/{first}").status_code == 404
    second = client.post("/api/garmin/upload", files={"file": ("x.fit", b"two")})
    assert second.status_code == 200 and second.json()["id"] != first


@pytest.mark.parametrize("failure", ["malformed_header", "cancel"])
def test_parser_allocated_disk_file_cleanup(client, monkeypatch, failure):
    """Retain actual parser instances/files: GC cannot hide a parser-spool leak.

    Instrumentation is test-only. Production must not patch Starlette globals.
    Both failures happen AFTER replay has written and rolled the first file.
    """
    from starlette.formparsers import MultiPartParser

    stages, parsers = [], []
    real_spool = upload_limits.tempfile.SpooledTemporaryFile
    real_parse = MultiPartParser.parse

    def stage(*args, **kwargs):
        f = real_spool(*args, **kwargs)
        stages.append(f)
        return f

    async def parse(parser):
        parsers.append(parser)
        if failure == "cancel":
            source = parser.stream

            async def interrupted():
                async for chunk in source:
                    if any(f._rolled for f in parser._files_to_close_on_error):
                        raise asyncio.CancelledError()
                    yield chunk

            parser.stream = interrupted()
        return await real_parse(parser)

    monkeypatch.setattr(upload_limits, "CHUNK_BYTES", 128)
    monkeypatch.setattr(upload_limits.tempfile, "SpooledTemporaryFile", stage)
    monkeypatch.setattr(MultiPartParser, "spool_max_size", 64)
    monkeypatch.setattr(MultiPartParser, "parse", parse)
    extra = b"--test\r\ninvalid header\r\n\r\nx\r\n" if failure == "malformed_header" else b""
    body = multipart(b"x" * 512, extra)
    try:
        if failure == "cancel":
            with pytest.raises(asyncio.CancelledError):
                raw_request(client, body_chunks(body))
        else:
            status, _ = raw_request(client, body_chunks(body))
            assert status == 400
        assert stages and all(f.closed for f in stages), "guard staging file must close"
        files = [f for parser in parsers for f in parser._files_to_close_on_error]
        assert files and any(f._rolled for f in files), "must allocate and roll a parser file"
        assert all(f.closed for f in files), "parser-created file leaked after failed parse"
        assert client.get("/api/imports").json() == []
        assert not (db.data_dir() / "uploads").exists()
    finally:
        # Keep the fail-before reproduction itself from leaking handles.
        for parser in parsers:
            for f in parser._files_to_close_on_error:
                f.close()


def test_parser_cleanup_attempts_every_close_even_if_one_raises():
    from starlette.datastructures import Headers

    async def stream():
        yield b""

    parser = upload_limits.OwnedMultipartParser(Headers(), stream())
    closed = []

    class File:
        def __init__(self, name, broken=False):
            self.name, self.broken = name, broken

        def close(self):
            closed.append(self.name)
            if self.broken:
                raise OSError("synthetic close failure")

    parser._files_to_close_on_error.extend([File("first"), File("broken", True), File("last")])
    with pytest.raises(OSError, match="synthetic close failure"):
        parser.close_files()
    assert set(closed) == {"first", "broken", "last"}
