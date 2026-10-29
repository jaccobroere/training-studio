"""The model layer (ASSISTANTS.md §3): the only place that names a provider.

``build_model`` turns settings into a Pydantic AI model wrapped in ``LoggedModel``, which
writes one ``llm.call`` line per model request (streamed or not): model, outcome (``ok``,
``truncated``, ``aborted`` when the client went away, ``error``), latency, finish reason, tokens
and ``PROMPT_VERSION``. Never prompt text, tool data or replies.
Prompts live in ``prompts/*.md`` and are sent exactly as written.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import os
import time
import traceback
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from pydantic_ai.messages import ModelMessage, ModelResponse
from pydantic_ai.models import Model, ModelRequestParameters, StreamedResponse
from pydantic_ai.models.openai import OpenAIChatModel
from pydantic_ai.models.wrapper import WrapperModel
from pydantic_ai.providers.ollama import OllamaProvider
from pydantic_ai.settings import ModelSettings

from core.settings import Settings, settings

# Pydantic AI prints a banner to stdout on its first run; logs here are one JSON object a line.
os.environ.setdefault("PYDANTIC_AI_NO_BANNER", "1")

log = logging.getLogger("sports.llm")

PROMPTS = Path(__file__).with_name("prompts")


def prompt(name: str) -> str:
    return (PROMPTS / f"{name}.md").read_text()


# A short hash of every prompt file: ties each logged call to the exact text that produced it.
PROMPT_VERSION = hashlib.sha256(
    b"".join(p.read_bytes() for p in sorted(PROMPTS.glob("*.md")))).hexdigest()[:12]


class LoggedModel(WrapperModel):
    """Writes one ``llm.call`` line per model request; behaves exactly like the wrapped model."""

    def __init__(self, wrapped: Model, *, operation: str):
        super().__init__(wrapped)
        self.operation = operation

    def _log(self, t0: float, response: ModelResponse | None, error: BaseException | None) -> None:
        usage = response.usage if response else None
        finish = response.finish_reason if response else None
        # A client that goes away cancels the task or closes the stream: not a failure of the call.
        aborted = isinstance(error, asyncio.CancelledError | GeneratorExit)
        outcome = ("aborted" if aborted else "error") if error else ("truncated" if finish == "length" else "ok")
        log.log(logging.WARNING if error and not aborted else logging.INFO, "llm call %s", outcome, extra={
            "event": "llm.call", "operation": self.operation, "model": self.model_name, "outcome": outcome,
            "error_type": type(error).__name__ if error and not aborted else None,
            "latency_ms": round((time.perf_counter() - t0) * 1000), "finish_reason": finish,
            "input_tokens": usage.input_tokens if usage else None,
            "output_tokens": usage.output_tokens if usage else None,
            "prompt_version": PROMPT_VERSION})

    async def request(self, messages: list[ModelMessage], model_settings: ModelSettings | None,
                      model_request_parameters: ModelRequestParameters) -> ModelResponse:
        t0 = time.perf_counter()
        try:
            response = await super().request(messages, model_settings, model_request_parameters)
        except BaseException as e:
            self._log(t0, None, e)
            raise
        self._log(t0, response, None)
        return response

    @asynccontextmanager
    async def request_stream(self, messages: list[ModelMessage], model_settings: ModelSettings | None,
                             model_request_parameters: ModelRequestParameters,
                             run_context: Any = None) -> AsyncIterator[StreamedResponse]:
        t0 = time.perf_counter()
        stream: StreamedResponse | None = None
        try:
            async with super().request_stream(messages, model_settings, model_request_parameters,
                                              run_context) as stream:
                yield stream
        except BaseException as e:
            self._log(t0, stream.get() if stream else None, e)
            raise
        self._log(t0, stream.get(), None)


def scrubbed_traceback(error: BaseException) -> str:
    """The stack of an error and of its causes, without any exception message. A provider's
    exception text can carry its response body (and headers), so a log line gets the types and
    the stack, which say where and what, never the text. The status code is a separate field."""
    chain: list[BaseException] = []
    e: BaseException | None = error
    while e is not None and e not in chain:
        chain.append(e)
        e = e.__cause__ or e.__context__
    return "\n".join(
        "Traceback (most recent call last):\n"
        + "".join(traceback.TracebackException.from_exception(c).stack.format())
        + f"{type(c).__module__}.{type(c).__qualname__}\n"
        for c in reversed(chain))


def configured(s: Settings | None = None) -> bool:
    """Whether a call can succeed at all; without a key the chat says it is off."""
    return bool((s or settings()).api_key)


def build_model(s: Settings | None = None, *, operation: str = "assistant.chat") -> Model:
    s = s or settings()
    if not s.api_key:
        raise RuntimeError("OLLAMA_API_KEY is not configured")
    # Ollama Cloud's OpenAI-compatible API. Another provider (Bedrock, Anthropic) is a branch
    # here plus its Pydantic AI extra; nothing else names one.
    inner = OpenAIChatModel(s.model, provider=OllamaProvider(base_url=s.ollama_base_url, api_key=s.api_key))
    return LoggedModel(inner, operation=operation)
