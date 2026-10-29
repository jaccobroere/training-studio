"""The media decoder child must not inherit the app's secrets."""

from __future__ import annotations

import base64
import json

from media import store


def test_the_media_worker_gets_no_app_secrets_and_keeps_the_temp_path(monkeypatch):
    captured = {}

    class Result:
        returncode = 0
        stdout = json.dumps(
            {
                "media": store.PNG,
                "ext": "png",
                "width": 1,
                "height": 1,
                "n_pages": 1,
                "text": "",
                "data": base64.b64encode(b"x").decode(),
                "pages": [],
            }
        ).encode()

    def fake_run(*args, **kwargs):
        captured.update(kwargs)
        return Result()

    monkeypatch.setattr(store.subprocess, "run", fake_run)
    monkeypatch.setattr(store, "validate", lambda content, purpose: store.PNG)
    monkeypatch.setenv("OLLAMA_API_KEY", "must-not-leak")
    monkeypatch.setenv("TMPDIR", "/app/data/tmp")

    store.process(b"x", "entity")

    assert "OLLAMA_API_KEY" not in captured["env"]
    assert captured["env"]["TMPDIR"] == "/app/data/tmp"
    assert captured["env"]["HOME"]
