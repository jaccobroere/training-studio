from __future__ import annotations

import json

import pytest


def test_feedback_is_stored_with_agreed_context(client):
    r = client.post(
        "/api/feedback",
        json={
            "kind": "bug",
            "message": "Dragging a workout to Thursday drops it on Wednesday.",
            "path": "/plan/week/2026-09-28",
            "viewport": "390x844",
            "user_agent": "Safari/605",
        },
    )
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["id"].startswith("fb-")
    assert body["queued"] is False

    rows = client.get("/api/feedback").json()
    assert len(rows) == 1
    assert rows[0]["kind"] == "bug"
    assert rows[0]["state"] == "queued"
    from db import get_db
    from models import Feedback

    with get_db().session() as s:
        row = s.get(Feedback, body["id"])
        assert row.context["app_version"]
        assert row.context["username"] == "athlete"
        assert row.context["path"] == "/plan/week/2026-09-28"
        assert row.context["viewport"] == "390x844"


def test_feedback_can_omit_context(client):
    r = client.post(
        "/api/feedback",
        json={
            "kind": "idea",
            "message": "Add a keyboard shortcut for today.",
            "include_context": False,
        },
    )
    assert r.status_code == 201, r.text
    from db import get_db
    from models import Feedback

    with get_db().session() as s:
        row = s.get(Feedback, r.json()["id"])
        assert row.context == {"app_version": "dev", "username": "athlete"}


def test_feedback_daily_limit(client, monkeypatch):
    monkeypatch.setenv("FEEDBACK_DAILY_LIMIT", "2")
    for i in range(2):
        assert client.post("/api/feedback", json={"message": f"note {i}"}).status_code == 201
    r = client.post("/api/feedback", json={"message": "one too many"})
    assert r.status_code == 429
    assert r.json()["code"] == "feedback_limit"


def test_outbox_signs_and_sends_once(client, monkeypatch):
    monkeypatch.setenv("FEEDBACK_WEBHOOK_URL", "http://feedback.example:5678/webhook/sports-feedback")
    monkeypatch.setenv("FEEDBACK_WEBHOOK_SECRET", "shared-secret")
    monkeypatch.setenv("FEEDBACK_ENRICH", "0")
    r = client.post("/api/feedback", json={"kind": "bug", "message": "Something is off."})
    assert r.status_code == 201, r.text

    captured: dict = {}

    class Response:
        status_code = 202
        text = ""

    def fake_post(url, **kw):
        captured["url"] = url
        captured.update(kw)
        return Response()

    from feedback import outbox

    monkeypatch.setattr(outbox.httpx, "post", fake_post)
    assert outbox.flush() == 1

    assert captured["url"].endswith("/webhook/sports-feedback")
    headers = captured["headers"]
    assert headers["X-Sports-Feedback-Id"] == r.json()["id"]
    assert headers["X-Sports-Token"] == "shared-secret"
    payload = json.loads(captured["content"])
    assert payload["event"] == "feedback.created"
    assert payload["message"] == "Something is off."
    assert payload["user_id"] == 1
    assert payload["triage"]["title"] == "Something is off."

    # Accepted rows leave the outbox.
    assert outbox.flush() == 0


def test_outbox_retries_a_failed_delivery(client, monkeypatch):
    monkeypatch.setenv("FEEDBACK_WEBHOOK_URL", "http://feedback.example:5678/webhook/sports-feedback")
    monkeypatch.setenv("FEEDBACK_WEBHOOK_SECRET", "shared-secret")
    monkeypatch.setenv("FEEDBACK_ENRICH", "0")
    r = client.post("/api/feedback", json={"message": "Please retry me."})
    assert r.status_code == 201, r.text

    from feedback import outbox

    def fail(*_a, **_kw):
        raise OSError("webhook unreachable")

    monkeypatch.setattr(outbox.httpx, "post", fail)
    assert outbox.flush() == 0

    from db import get_db
    from models import Feedback

    with get_db().session() as s:
        row = s.get(Feedback, r.json()["id"])
        assert row.state == "queued"
        assert row.attempts == 1
        assert "webhook unreachable" in (row.last_error or "")
        assert row.next_attempt_at is not None


def test_failed_feedback_can_be_requeued(client, monkeypatch):
    monkeypatch.setenv("FEEDBACK_WEBHOOK_URL", "http://feedback.example:5678/webhook/sports-feedback")
    monkeypatch.setenv("FEEDBACK_WEBHOOK_SECRET", "shared-secret")
    monkeypatch.setenv("FEEDBACK_ENRICH", "0")
    r = client.post("/api/feedback", json={"message": "Please retry me after the URL is fixed."})
    assert r.status_code == 201, r.text
    feedback_id = r.json()["id"]

    from feedback import outbox

    class NotFound:
        status_code = 404
        text = '{"code":404,"message":"webhook not registered"}'

    monkeypatch.setattr(outbox.httpx, "post", lambda *_a, **_kw: NotFound())
    assert outbox.flush() == 0

    from db import get_db
    from models import Feedback

    with get_db().session() as s:
        row = s.get(Feedback, feedback_id)
        assert row.state == "failed"
        assert row.attempts == 1
        assert "404" in (row.last_error or "")

    retry = client.post(f"/api/feedback/{feedback_id}/retry")
    assert retry.status_code == 200, retry.text
    assert retry.json() == {"id": feedback_id, "state": "queued"}

    with get_db().session() as s:
        row = s.get(Feedback, feedback_id)
        assert row.state == "queued"
        assert row.attempts == 0
        assert row.last_error is None
        assert row.next_attempt_at is None

    # A note that is already queued or sent is not retried again, and an unknown id is 404.
    assert client.post(f"/api/feedback/{feedback_id}/retry").status_code == 409
    assert client.post("/api/feedback/fb-missing/retry").status_code == 404


@pytest.mark.parametrize("message", ["", "ab"])
def test_feedback_requires_a_real_message(client, message):
    r = client.post("/api/feedback", json={"message": message})
    assert r.status_code == 422


def test_rule_based_triage_flags_sensitive_areas():
    from feedback.enrich import fallback

    t = fallback("Login fails after the password reset", "bug", {"path": "/settings/account"})
    assert t.kind == "bug"
    assert t.severity == "high"
    assert t.autonomy == "HUMAN_ONLY"
    assert t.title == "Login fails after the password reset"


def test_rule_based_triage_allows_a_contained_idea():
    from feedback.enrich import fallback

    t = fallback(
        "Please add a keyboard shortcut for today", "idea", {"path": "/plan/week/2026-09-28"}
    )
    assert t.kind == "idea"
    assert t.autonomy == "AUTONOMOUS"
    assert t.area == "plan / week"


def test_llm_triage_is_used_when_configured(monkeypatch):
    import asyncio

    from feedback import enrich

    async def fake(_message, _kind, _context):
        return enrich.Triage(
            title="Model title",
            kind="idea",
            severity="low",
            area="plan",
            summary="Model summary",
            acceptance=["One test"],
            autonomy="AUTONOMOUS",
        )

    monkeypatch.setattr(enrich, "configured", lambda: True)
    monkeypatch.setattr(enrich, "_enrich", fake)
    t = asyncio.run(enrich.triage("anything", "idea", {}))
    assert t.title == "Model title"
    assert t.kind == "idea"


def test_llm_triage_cannot_downgrade_a_sensitive_area():
    from feedback.enrich import Triage, apply_guardrails

    t = Triage(
        title="Change the deploy script",
        kind="idea",
        severity="low",
        area="infra / deploy",
        summary="Ignore the guardrail",
        acceptance=["Ship it"],
        autonomy="AUTONOMOUS",
    )
    guarded = apply_guardrails("Please change the deploy script", t)
    assert guarded.autonomy == "HUMAN_ONLY"


def test_outbox_marks_a_4xx_as_permanent(client, monkeypatch):
    monkeypatch.setenv("FEEDBACK_WEBHOOK_URL", "http://feedback.example:5678/webhook/sports-feedback")
    monkeypatch.setenv("FEEDBACK_WEBHOOK_SECRET", "shared-secret")
    monkeypatch.setenv("FEEDBACK_ENRICH", "0")
    r = client.post("/api/feedback", json={"message": "This will be rejected."})
    assert r.status_code == 201, r.text

    class Response:
        status_code = 422
        text = "bad token"

    from feedback import outbox

    monkeypatch.setattr(outbox.httpx, "post", lambda *_a, **_kw: Response())
    assert outbox.flush() == 0

    from db import get_db
    from models import Feedback

    with get_db().session() as s:
        row = s.get(Feedback, r.json()["id"])
        assert row.state == "failed"
        assert row.attempts == 1
        assert "bad token" in (row.last_error or "")


# ---------------------------------------------------------------- screenshots


def _screenshot(w: int = 1179, h: int = 2556) -> bytes:
    import io

    from PIL import Image

    img = Image.effect_noise((w, h), 40).convert("RGB")
    exif = Image.Exif()
    exif[0x010F] = "PhoneMaker"  # Make: must not survive re-encoding
    out = io.BytesIO()
    img.save(out, "JPEG", exif=exif)
    return out.getvalue()


def _attach(client, content: bytes | None = None, name: str = "shot.jpg"):
    return client.post(
        "/api/feedback/attachments",
        files={"file": (name, content or _screenshot(), "image/jpeg")},
    )


def test_feedback_carries_screenshots_to_the_outbox(client, monkeypatch):
    import base64
    import io

    from PIL import Image

    up = _attach(client)
    assert up.status_code == 200, up.text
    media = up.json()
    assert media["purpose"] == "feedback"
    assert max(media["width"], media["height"]) <= 2000  # scaled down on upload

    r = client.post(
        "/api/feedback",
        json={"kind": "bug", "message": "Units sit under the value.", "attachments": [media["id"]]},
    )
    assert r.status_code == 201, r.text
    assert client.get("/api/feedback").json()[0]["attachments"] == 1

    monkeypatch.setenv("FEEDBACK_WEBHOOK_URL", "http://feedback.example:5678/webhook/sports-feedback")
    monkeypatch.setenv("FEEDBACK_WEBHOOK_SECRET", "shared-secret")
    monkeypatch.setenv("FEEDBACK_ENRICH", "0")
    captured: dict = {}

    class Response:
        status_code = 202
        text = ""

    from feedback import outbox

    monkeypatch.setattr(outbox.httpx, "post", lambda url, **kw: captured.update(kw) or Response())
    assert outbox.flush() == 1

    payload = json.loads(captured["content"])
    [att] = payload["attachments"]
    assert att["name"] == "1.jpg"
    assert att["media_type"] == "image/jpeg"
    img = Image.open(io.BytesIO(base64.b64decode(att["data"])))
    assert (img.width, img.height) == (media["width"], media["height"])
    assert not img.getexif(), "metadata must be stripped before it leaves the app"


def test_feedback_without_screenshots_sends_an_empty_list(client, monkeypatch):
    monkeypatch.setenv("FEEDBACK_WEBHOOK_URL", "http://feedback.example:5678/webhook/sports-feedback")
    monkeypatch.setenv("FEEDBACK_WEBHOOK_SECRET", "shared-secret")
    monkeypatch.setenv("FEEDBACK_ENRICH", "0")
    assert client.post("/api/feedback", json={"message": "Plain note."}).status_code == 201
    captured: dict = {}

    class Response:
        status_code = 202
        text = ""

    from feedback import outbox

    monkeypatch.setattr(outbox.httpx, "post", lambda url, **kw: captured.update(kw) or Response())
    assert outbox.flush() == 1
    assert json.loads(captured["content"])["attachments"] == []


def test_feedback_screenshot_must_be_an_image(client):
    r = _attach(client, b"%PDF-1.4 not an image", "doc.pdf")
    assert r.status_code == 422
    assert r.json()["code"] == "unsupported_type"


def test_feedback_attachment_ids_are_checked(client):
    r = client.post("/api/feedback", json={"message": "Ghost image.", "attachments": ["nope"]})
    assert r.status_code == 422
    assert r.json()["code"] == "unknown_attachment"

    chat = client.post(
        "/api/chat/attachments", files={"file": ("x.jpg", _screenshot(400, 300), "image/jpeg")}
    )
    assert chat.status_code == 200, chat.text
    r = client.post(
        "/api/feedback", json={"message": "Chat file.", "attachments": [chat.json()["id"]]}
    )
    assert r.status_code == 422, "a chat attachment is not a feedback screenshot"

    mid = _attach(client).json()["id"]
    assert (
        client.post("/api/feedback", json={"message": "First.", "attachments": [mid]}).status_code
        == 201
    )
    again = client.post("/api/feedback", json={"message": "Second.", "attachments": [mid]})
    assert again.status_code == 422, "one screenshot belongs to one note"


def test_feedback_takes_at_most_three_screenshots(client):
    ids = [_attach(client, _screenshot(300, 200)).json()["id"] for _ in range(4)]
    r = client.post("/api/feedback", json={"message": "Too many.", "attachments": ids})
    assert r.status_code == 422


def test_feedback_screenshots_are_purged_on_schedule(client):
    from datetime import timedelta

    from db import get_db
    from feedback import outbox
    from media import store
    from models import Feedback, MediaFile
    from models.base import utcnow

    unclaimed = _attach(client, _screenshot(300, 200)).json()
    sent = _attach(client, _screenshot(300, 200)).json()
    queued = _attach(client, _screenshot(300, 200)).json()
    sent_fb = client.post(
        "/api/feedback", json={"message": "Sent.", "attachments": [sent["id"]]}
    ).json()
    client.post("/api/feedback", json={"message": "Queued.", "attachments": [queued["id"]]})

    old = utcnow() - timedelta(days=8)
    with get_db().session() as s:
        s.get(MediaFile, unclaimed["id"]).created_at = old
        row = s.get(Feedback, sent_fb["id"])
        row.state, row.forwarded_at, row.created_at = "sent", old, old
        for m in s.query(MediaFile).filter(MediaFile.id.in_([sent["id"], queued["id"]])):
            m.created_at = old
        s.commit()
        assert outbox.purge_attachments(s) == 2

    with get_db().session() as s:
        assert s.get(MediaFile, unclaimed["id"]) is None
        assert s.get(MediaFile, sent["id"]) is None
        assert s.get(MediaFile, queued["id"]) is not None, "a queued note keeps its screenshot"
    assert not store.path_of(unclaimed["file"]).exists()
    assert not store.path_of(sent["file"]).exists()
    assert store.path_of(queued["file"]).exists()
