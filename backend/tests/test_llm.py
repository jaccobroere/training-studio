"""The model layer (chat/llm.py): one `llm.call` line per model request, no content, and the
analysis runner failing closed in production."""

from __future__ import annotations

import logging

import pytest
from pydantic_ai import Agent
from pydantic_ai.messages import ModelResponse, TextPart
from pydantic_ai.models.function import FunctionModel
from pydantic_ai.usage import RequestUsage
from test_chat import call, chat_client, say, scripted, send  # noqa: F401 (fixture)

SECRET = "my knee hurts after the long run"


def _calls(caplog):
    return [r for r in caplog.records if getattr(r, "event", None) == "llm.call"]


def test_one_line_per_request_with_metadata_and_no_content(caplog):
    from chat.llm import PROMPT_VERSION, LoggedModel

    def reply(messages, info):
        return ModelResponse(parts=[TextPart("Rest two days.")], usage=RequestUsage(input_tokens=42, output_tokens=7),
                             finish_reason="stop")

    agent = Agent(LoggedModel(FunctionModel(reply), operation="test.op"))
    with caplog.at_level(logging.INFO, logger="sports.llm"):
        assert agent.run_sync(SECRET).output == "Rest two days."
    (rec,) = _calls(caplog)
    assert (rec.operation, rec.outcome, rec.error_type) == ("test.op", "ok", None)
    assert (rec.input_tokens, rec.output_tokens, rec.finish_reason) == (42, 7, "stop")
    assert rec.prompt_version == PROMPT_VERSION and len(PROMPT_VERSION) == 12
    assert isinstance(rec.latency_ms, int)
    assert SECRET not in str(rec.__dict__) and "Rest two days" not in str(rec.__dict__)


def test_streamed_requests_and_errors_are_logged(caplog):
    from chat.llm import LoggedModel

    async def stream(messages, info):
        yield "Short answer."

    def boom(messages, info):
        raise ConnectionError("provider down")

    with caplog.at_level(logging.INFO, logger="sports.llm"):
        out = Agent(LoggedModel(FunctionModel(stream_function=stream), operation="s")).run_stream_sync(SECRET)
        assert out.get_output() == "Short answer."
        with pytest.raises(ConnectionError):
            Agent(LoggedModel(FunctionModel(boom), operation="e")).run_sync(SECRET)
    ok, err = _calls(caplog)
    assert ok.operation == "s" and ok.outcome == "ok"
    assert err.outcome == "error" and err.error_type == "ConnectionError" and err.input_tokens is None


def test_a_chat_turn_logs_each_model_request(chat_client, caplog):
    """A tool call and the answer after it are two model requests: two lines."""
    from chat.llm import LoggedModel

    client, ca = chat_client
    model = LoggedModel(scripted([call("get_profile", {}), say("Your Profile is set.")]), operation="assistant.chat")
    with caplog.at_level(logging.INFO, logger="sports.llm"), ca.agent().override(model=model):
        send(client, "What's in my profile?")
    lines = _calls(caplog)
    assert [r.outcome for r in lines] == ["ok", "ok"] and {r.operation for r in lines} == {"assistant.chat"}


def test_build_model_needs_a_key_and_logs_under_the_chat_operation(monkeypatch):
    from chat import llm

    monkeypatch.delenv("OLLAMA_API_KEY", raising=False)
    assert llm.configured() is False
    with pytest.raises(RuntimeError):
        llm.build_model()
    monkeypatch.setenv("OLLAMA_API_KEY", "k")
    monkeypatch.setenv("SPORTS_MODEL", "glm-5.3")
    m = llm.build_model()
    assert isinstance(m, llm.LoggedModel) and m.operation == "assistant.chat" and m.model_name == "glm-5.3"


def test_the_policy_is_the_prompt_file_as_written(chat_client):
    from chat.llm import prompt

    _client, ca = chat_client
    text = prompt("system")
    assert text.startswith("You are the training assistant") and "{guide}" in text
    assert ca.POLICY == text


def test_production_without_the_runner_fails_closed(env, monkeypatch):
    from analysis import runner

    monkeypatch.setenv("APP_ENV", "production")
    monkeypatch.delenv("PYRUNNER_URL", raising=False)
    ran = []
    monkeypatch.setattr(runner, "run_job", lambda *a: ran.append(a) or {"status": "ok", "stdout": "1\n"})
    out, name = runner.sandbox("print(1)", {})
    assert out["status"] == "failed" and "not configured" in out["error"] and name == "none" and not ran

    monkeypatch.setenv("APP_ENV", "dev")  # development keeps the local limited subprocess
    out, name = runner.sandbox("print(1)", {})
    assert out["status"] == "ok" and name == "local-subprocess" and len(ran) == 1


def test_a_client_that_goes_away_is_an_aborted_call_not_an_error(caplog):
    """Cancellation (task cancel) and a closed stream (GeneratorExit) log one INFO line with
    outcome=aborted and no error type; any other exception stays an error."""
    import asyncio

    from chat.llm import LoggedModel

    async def hangs(messages, info):
        yield "partial"
        await asyncio.sleep(60)

    async def cancel_mid_request():
        agent = Agent(LoggedModel(FunctionModel(stream_function=hangs), operation="a"))

        async def consume():
            async with agent.run_stream("x") as run:
                async for _ in run.stream_text(delta=True):
                    pass

        task = asyncio.ensure_future(consume())
        await asyncio.sleep(0.05)
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass

    async def close_stream():
        agent = Agent(LoggedModel(FunctionModel(stream_function=hangs), operation="b"))
        async with agent.run_stream("x") as run:
            async for _ in run.stream_text(delta=True):
                break  # the client reads one chunk and leaves

    with caplog.at_level(logging.INFO, logger="sports.llm"):
        asyncio.run(cancel_mid_request())
        asyncio.run(close_stream())
    lines = _calls(caplog)
    assert [(r.operation, r.outcome, r.error_type, r.levelno) for r in lines] == [
        ("a", "aborted", None, logging.INFO), ("b", "aborted", None, logging.INFO)]
