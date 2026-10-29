import json
import logging

from test_chat import chat_client, post_chat, scripted  # noqa: F401 (fixture)

from chat.api import error_kind, plain_error


def test_provider_bodies_never_reach_the_athlete():
    raw = "status_code: 401, model_name: x, body: {'error': 'unauthorized key sk-123'}"
    assert plain_error(raw) == "The assistant isn't available right now. Try again later."
    assert "usage limit" in plain_error("status_code: 429, body: {...}")
    assert "step limit" in plain_error("The next request would exceed the request_limit of 16")
    assert plain_error("boom: secret internals") == "The assistant couldn't answer. Please try again."


def test_error_copy_is_for_the_athlete_not_the_operator():
    for raw in ("status_code: 401", "status_code: 403", "status_code: 429", "request_limit", "boom"):
        assert not {"OLLAMA", "KEY", "key", "env", "model provider refused"} & set(plain_error(raw).split())
        assert "OLLAMA_API_KEY" not in plain_error(raw)
    assert [error_kind(t) for t in ("status_code: 401", "status_code: 429", "request_limit", "boom")] == [
        "provider_auth", "provider_rate_limit", "step_limit", "error"]


def test_a_failed_turn_is_logged_with_type_status_and_stack_but_never_the_provider_text(chat_client, caplog):
    from pydantic_ai.exceptions import ModelHTTPError

    from core.logging import JsonFormatter
    from core.settings import settings

    client, ca = chat_client

    # Runtime values, not literals: the stack's source lines are code and may quote literals.
    key, sess, model = "sk" + "-123", "sess" + "-456", "kimi" + "-k3"

    def dies(messages):
        raise ModelHTTPError(401, model, {"error": f"bad {key}", "headers": f"Set-Cookie: {sess}"})

    with caplog.at_level(logging.INFO, logger="chat.api"), ca.agent().override(model=scripted([dies])):
        r = post_chat(client, "hello", tid="t-fail")
    events = [json.loads(line[6:]) for line in r.text.splitlines()
              if line.startswith("data: ") and line[6:].strip() not in ("", "[DONE]")]
    (err,) = [e for e in events if e.get("type") == "error"]
    assert err["errorText"] == "The assistant isn't available right now. Try again later."
    assert key not in r.text and "OLLAMA" not in r.text
    (rec,) = [x for x in caplog.records if getattr(x, "event", None) == "chat.turn_failed"]
    assert (rec.error_type, rec.kind, rec.status_code) == ("ModelHTTPError", "provider_auth", 401)
    assert rec.levelno == logging.WARNING and rec.exc_info is None
    line = JsonFormatter(settings()).format(rec)
    out = json.loads(line)
    assert "ModelHTTPError" in out["exc"] and 'File "' in out["exc"]  # where and what: the stack
    for secret in (key, sess, model):
        assert secret not in line  # the provider's body, headers and model name text stay out


def test_scrubbed_traceback_covers_the_cause_chain_without_messages():
    from chat.llm import scrubbed_traceback

    body = "sec" + "ret-body"  # a runtime value: source lines in the stack are code
    try:
        try:
            raise ValueError(f"root cause {body}")
        except ValueError as e:
            raise RuntimeError(f"wrapper {body}") from e
    except RuntimeError as e:
        out = scrubbed_traceback(e)
    assert "builtins.ValueError" in out and "builtins.RuntimeError" in out
    assert out.index("ValueError") < out.index("RuntimeError")  # root cause first, as Python prints it
    assert body not in out
