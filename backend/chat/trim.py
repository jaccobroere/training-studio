"""Bounded context for long threads (a Pydantic AI history processor).

History is stored in full, but what the model sees each request is: the last `ASSISTANT_KEEP_TURNS`
turns verbatim (a turn = one typed user message and everything the agent did for it), older
tool results reduced to their step metadata (label, source, summary and the ids/status the
replay notes rely on), older attachment text replaced by a short stub, and — if the total is
still over `ASSISTANT_HISTORY_CHARS` — whole oldest turns dropped. Tool calls and their returns are never
separated, and the current turn is never touched.
"""

from __future__ import annotations

import json
import re
from dataclasses import replace
from typing import Any

from pydantic_ai.messages import (
    ModelMessage,
    ModelRequest,
    ModelResponse,
    ToolCallPart,
    ToolReturnPart,
    UserPromptPart,
)

from core.settings import settings

KEEP_KEYS = ("label", "source", "summary", "ok", "error", "change_id", "proposal_id", "status_now",
             "saved", "analysis_id", "pinned_id", "title")
ARG_CHARS = 400
_FENCE = re.compile(r"<untrusted_attachment id=\"([^\"]*)\">.*?</untrusted_attachment>", re.S)


def _typed(m: ModelMessage) -> bool:
    return isinstance(m, ModelRequest) and any(isinstance(p, UserPromptPart) for p in m.parts)


def _stub_return(p: ToolReturnPart) -> ToolReturnPart:
    c = p.content
    if isinstance(c, dict):
        stub = {k: c[k] for k in KEEP_KEYS if k in c}
        stub["note"] = "older result, shortened; call the tool again for details"
        return replace(p, content=stub)
    text = str(c)
    return replace(p, content=text if len(text) <= 300 else text[:300] + " … [trimmed]")


def _stub_prompt(p: UserPromptPart) -> UserPromptPart:
    def clean(s: str) -> str:
        return _FENCE.sub(lambda m: f"[text of attachment {m.group(1)} omitted: older message]", s)

    if isinstance(p.content, str):
        return p
    return replace(p, content=[clean(c) if isinstance(c, str) else c for c in p.content])


SHORT_STR, KEEP_ITEMS = 100, 2


def shorten(v: Any) -> Any:
    """The same JSON with the same keys, long strings cut and long lists cut to their first
    items. The shape of the call stays what the tool accepts: the model copies what it sees in
    its history, and an invented key (or a missing one) would fail the tool's validation."""
    if isinstance(v, str):
        return v if len(v) <= SHORT_STR else v[:SHORT_STR] + "… [shortened]"
    if isinstance(v, list):
        return [shorten(x) for x in v[:KEEP_ITEMS]]
    if isinstance(v, dict):
        return {k: shorten(x) for k, x in v.items()}
    return v


def _stub_call(p: ToolCallPart) -> ToolCallPart:
    args = p.args if isinstance(p.args, str) else json.dumps(p.args, default=str)
    if len(args) <= ARG_CHARS:
        return p
    try:
        data = json.loads(args)
    except ValueError:
        data = {}
    return replace(p, args=json.dumps(shorten(data)) if isinstance(data, dict) else "{}")


def _trim(m: ModelMessage) -> ModelMessage:
    if isinstance(m, ModelRequest):
        parts = [_stub_return(p) if isinstance(p, ToolReturnPart) else
                 _stub_prompt(p) if isinstance(p, UserPromptPart) else p for p in m.parts]
        return replace(m, parts=parts)
    if isinstance(m, ModelResponse):
        return replace(m, parts=[_stub_call(p) if isinstance(p, ToolCallPart) else p for p in m.parts])
    return m


def size(messages: list[ModelMessage]) -> int:
    return sum(len(repr(p)) for m in messages for p in m.parts)


def trim_history(messages: list[ModelMessage]) -> list[ModelMessage]:
    keep_turns, budget = settings().assistant_keep_turns, settings().assistant_history_chars
    starts = [i for i, m in enumerate(messages) if _typed(m)]
    if len(starts) <= keep_turns:
        cut = 0
    else:
        cut = starts[-keep_turns]
    out = [_trim(m) for m in messages[:cut]] + list(messages[cut:])
    # Over budget: drop whole oldest turns (never the kept ones).
    keep_from = len(messages[:cut])
    while size(out) > budget and keep_from > 0:
        nxt = next((i for i, m in enumerate(out[1:], 1) if _typed(m)), None)
        if nxt is None or nxt > keep_from:
            out = out[keep_from:]
            keep_from = 0
            break
        out = out[nxt:]
        keep_from -= nxt
    return out
