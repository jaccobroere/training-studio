"""Tool-argument validation errors, as short sentences instead of pydantic's JSON dump.

When the model's tool arguments fail validation, Pydantic AI turns the `ValidationError` into a
retry prompt ("4 validation errors: ```json … ```") that the model reads and that the chat card
shows the athlete. `FriendlyToolErrors` rewrites it into a few plain lines that say what to fix
(a missing field, an unknown field, an op without `op`). The model still retries on its own with
the usual budget; nothing is hidden, only shortened. The raw error types go to the log, never
the argument values (they can hold the athlete's notes).
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from typing import Any, get_args

from pydantic import ValidationError
from pydantic_ai import RunContext
from pydantic_ai.capabilities import AbstractCapability
from pydantic_ai.exceptions import ModelRetry
from pydantic_ai.messages import ToolCallPart
from pydantic_ai.tools import ToolDefinition

log = logging.getLogger(__name__)
MAX_LINES = 5


def op_names() -> list[str]:
    from plan.ops import PUBLIC

    return [get_args(c.model_fields["op"].annotation)[0] for c in PUBLIC] + ["attach_link"]


def _path(loc: tuple, skip: set[str]) -> str:
    out = ""
    for seg in loc:
        if isinstance(seg, int):
            out += f"[{seg}]"
        elif seg in skip:  # the union branch's name, not a field
            continue
        else:
            out += f".{seg}" if out else str(seg)
    return out or "arguments"


def _line(e: dict, skip: set[str], ops: list[str]) -> str:
    where, kind = _path(tuple(e.get("loc", ())), skip), e.get("type", "")
    if kind == "missing":
        return f"{where} is required"
    if kind == "extra_forbidden":
        return f"{where} is not a field here; remove it"
    if kind == "union_tag_not_found":
        return f"{where} has no `op`; give it one of: {', '.join(ops[:8])}, …"
    if kind == "union_tag_invalid":
        got = e.get("input", {}).get("op") if isinstance(e.get("input"), dict) else None
        return f"{where} has an unknown op{f' {got!r}' if got else ''}; use one of: {', '.join(ops[:8])}, …"
    msg = str(e.get("msg", "invalid")).removeprefix("Value error, ")
    return f"{where}: {msg}"


def describe(error: ValidationError, tool: str, args: Any, required: list[str]) -> str:
    """One short paragraph for the model (and the athlete's card) for a failed tool call."""
    errors = error.errors(include_url=False, include_context=False)
    ops = op_names()
    skip = set(ops)
    lines, seen = [], set()
    for e in errors:
        text = _line(e, skip, ops)
        if text not in seen:
            seen.add(text)
            lines.append(text)
    more = f" (and {len(lines) - MAX_LINES} more)" if len(lines) > MAX_LINES else ""
    head = f"The `{tool}` call was not run (nothing changed): " + "; ".join(lines[:MAX_LINES]) + more + "."
    given = args if isinstance(args, dict) else {}
    if not given and isinstance(args, str):
        try:
            loaded = json.loads(args)
            given = loaded if isinstance(loaded, dict) else {}
        except ValueError:
            given = {}
    if "trimmed" in given or any("[shortened]" in str(v) for v in given.values()):
        head += " Those arguments were an abbreviated copy of an older call: send the complete, real arguments."
    if any(e.get("type") == "missing" and len(e.get("loc", ())) == 1 for e in errors) and required:
        head += f" Required arguments: {', '.join(required)}."
    return head


@dataclass
class FriendlyToolErrors(AbstractCapability):
    """Reword failed tool-argument validation (see the module docstring)."""

    async def on_tool_validate_error(self, ctx: RunContext, *, call: ToolCallPart, tool_def: ToolDefinition,
                                     args: Any, error: ValidationError | ModelRetry):
        if not isinstance(error, ValidationError):
            raise error
        required = list((tool_def.parameters_json_schema or {}).get("required") or [])
        types = sorted({str(e.get("type")) for e in error.errors(include_url=False, include_context=False)})
        log.info("tool arguments rejected", extra={
            "event": "chat.tool_args_invalid", "tool": call.tool_name, "n_errors": error.error_count(),
            "error_types": types})
        raise ModelRetry(describe(error, call.tool_name, args, required)) from error
