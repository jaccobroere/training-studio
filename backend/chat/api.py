"""Assistant endpoints. Streams the Vercel AI UI-message protocol (v7) to `useChat`.

History lives here, server-side: the client sends only the new user message, the thread id,
the scope it was sent from and any attachment ids. Plan edits happen inside tools through the
change seam; proposals are stored server-side and applied by id (chat/proposals.py).

A turn: admission (quota, per-minute window, per-user lock) → one short DB phase (history,
replay of earlier proposals/changes, attachments, scope) that is closed before the model is
called → a global concurrency slot → the streamed run, with claim stripping on the text →
on completion the history is stored (images replaced by notes, false claims stripped) and the
turn is counted.

Preambles: a short text part the model writes right before a tool call in the same response
("I'll read the guide and your calendar first.") is step narration — the tool-step rows already
show it. It is held back while streaming and dropped if a tool call follows; it is dropped from
the stored history too. Longer text, or text with a question, always goes through.
"""

from __future__ import annotations

import json
import logging
import re
import threading
import uuid
from dataclasses import dataclass, field, replace
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic_ai.messages import (
    ModelMessage,
    ModelMessagesTypeAdapter,
    ModelRequest,
    ModelResponse,
    TextPart,
    ToolCallPart,
    ToolReturnPart,
    UserPromptPart,
)
from pydantic_ai.ui.vercel_ai import VercelAIAdapter, VercelAIEventStream
from pydantic_ai.ui.vercel_ai.response_types import (
    ErrorChunk,
    TextDeltaChunk,
    TextEndChunk,
    TextStartChunk,
    ToolInputAvailableChunk,
    ToolInputStartChunk,
)
from pydantic_ai.usage import UsageLimits
from sqlalchemy import select
from sqlalchemy.orm import Session

import db
from accounts import service as accounts
from accounts.models import User
from chat import agent as chat_agent
from chat import attachments, claims, limits
from chat import proposals as props
from chat.llm import scrubbed_traceback
from chat.tools import ChatDeps, landed_kinds
from core.errors import error_response
from core.settings import settings
from db import get_session
from models import ChatProposal, Conversation
from models.base import utcnow
from plan import clock

log = logging.getLogger(__name__)
router = APIRouter(prefix="/api/chat")
SDK = 7
CONSENT_NOTE = ("Your messages, any files you attach (images and PDFs) and the plan, profile and health "
                "data the assistant reads to answer are sent to Ollama Cloud for processing. Nothing is "
                "used to train models by this app; credentials stay on the server.")


@router.get("/status")
def status(request: Request) -> dict:
    with db.auth_db().session() as s:
        user = s.get(User, request.scope["state"]["user_id"])
        use = accounts.usage(s, user).as_dict()
        consent = user.assistant_consent_at is not None
    return {"configured": chat_agent.configured(), "provider": "Ollama Cloud", "model": settings().model,
            "usage": use, "consent": consent, "note": CONSENT_NOTE,
            "attachments": {"images": attachments.images_enabled(), "pdf": True,
                            "max_per_message": attachments.MAX_PER_MESSAGE, "max_mb": 20,
                            "types": ["image/png", "image/jpeg", "image/webp", "image/heic", "application/pdf"]},
            "limits": {"per_minute": limits.per_minute()}}


def _thread_view(c: Conversation) -> dict:
    scopes = c.scopes or {}
    first = scopes.get("0") or {}
    return {"id": c.id, "title": c.title, "updated_at": c.updated_at.isoformat() + "Z",
            "turns": len(scopes), "scope": {k: first[k] for k in ("page", "monday", "label") if first.get(k)} or None}


@router.get("/threads")
def threads(db_: Session = Depends(get_session)) -> list[dict]:
    rows = db_.scalars(select(Conversation).order_by(Conversation.updated_at.desc()).limit(100)).all()
    return [_thread_view(c) for c in rows]


@router.post("/threads")
def new_thread(db_: Session = Depends(get_session)) -> dict:
    c = Conversation(id=f"t-{uuid.uuid4().hex[:12]}", title="New chat", history="[]", scopes={})
    db_.add(c)
    db_.commit()
    return _thread_view(c)


def _typed(m: ModelMessage) -> bool:
    return isinstance(m, ModelRequest) and any(isinstance(p, UserPromptPart) for p in m.parts)


def turn_history(history: list[ModelMessage], run_messages: list[ModelMessage]) -> list[ModelMessage]:
    """The history to store after a run: everything we sent in, then this turn's messages.

    `run_messages` may be shorter than `history` + turn (the history processor trims it), so the
    turn is found by its last typed prompt, never by an offset into `history`. A run with no
    typed prompt is not expected; storing its (trimmed) messages would lose history, so the
    stored history is kept as it was, and the turn is logged as not stored."""
    typed = [i for i, m in enumerate(run_messages) if _typed(m)]
    if not typed:
        log.error("turn has no typed prompt; history kept as it was", extra={"event": "chat.history_fallback"})
        return list(history)
    return [*history, *run_messages[typed[-1]:]]


@router.get("/threads/{tid}")
def thread(tid: str, db_: Session = Depends(get_session)) -> dict:
    c = db_.get(Conversation, tid)
    if c is None:  # a new thread the client has named but not used yet
        return {"id": tid, "title": "New chat", "updated_at": None, "turns": 0, "scope": None, "messages": [],
                "proposals": []}
    history = ModelMessagesTypeAdapter.validate_json(c.history or "[]")
    origin: dict[str, ModelMessage] = {}

    def message_id(msg: ModelMessage, role: str, i: int) -> str:
        origin[f"{tid}-{i}"] = msg
        return f"{tid}-{i}"

    ui = VercelAIAdapter.dump_messages(history, sdk_version=SDK, generate_message_id=message_id)
    msgs = []
    n = 0  # counts what the athlete typed, the same way chat() numbers the captured scopes
    for m in (x.model_dump(mode="json", by_alias=True, exclude_none=True) for x in ui):
        if m.get("role") == "system":
            continue
        if m.get("role") == "user":
            if not _typed(origin[m["id"]]):
                continue  # retry feedback the framework sent the model, not a message the athlete wrote
            texts = [p for p in m.get("parts", []) if p.get("type") == "text"]
            m["parts"] = texts[:1]  # the typed text; attachment blocks and image notes are model-only
            scope = dict((c.scopes or {}).get(str(n)) or {})
            m["metadata"] = {"scope": scope, "attachments": scope.pop("attachments", [])}
            n += 1
        msgs.append(m)
    plist = db_.scalars(select(ChatProposal).where(ChatProposal.thread_id == tid)
                        .order_by(ChatProposal.created_at)).all()
    return {**_thread_view(c), "messages": msgs,
            "proposals": [{"id": p.id, "status": props.status(db_, p), "title": p.title, "summary": p.summary}
                          for p in plist]}


@router.delete("/threads/{tid}")
def delete_thread(tid: str, db_: Session = Depends(get_session)) -> dict:
    c = db_.get(Conversation, tid)
    if c is not None:
        db_.delete(c)
    for p in db_.scalars(select(ChatProposal).where(ChatProposal.thread_id == tid)
                         .where(ChatProposal.status == "open")):
        p.status, p.decided_at = "discarded", utcnow()
    db_.commit()
    return {"ok": True}


def _first_text(body: dict) -> str:
    for m in reversed(body.get("messages") or []):
        if m.get("role") == "user":
            return " ".join(p.get("text", "") for p in m.get("parts", []) if p.get("type") == "text").strip()
    return ""


# ------------------------------------------------------------------ context replay

def replay(s: Session, tid: str, history: list[ModelMessage]) -> tuple[list[ModelMessage], str]:
    """Annotate earlier propose/change tool results with their status now, and summarise them
    for the instructions (stenen's proposal_note, on Pydantic AI messages)."""
    notes: list[str] = []
    seen: set[str] = set()
    out: list[ModelMessage] = []
    for m in history:
        if isinstance(m, ModelRequest) and any(isinstance(p, ToolReturnPart) for p in m.parts):
            parts = []
            for p in m.parts:
                if isinstance(p, ToolReturnPart) and isinstance(p.content, dict):
                    now = None
                    if p.content.get("proposal_id"):
                        row = s.get(ChatProposal, p.content["proposal_id"])
                        now = props.brief(s, row) if row else "proposal no longer available"
                    elif p.content.get("change_id") and p.tool_name in ("change", "undo_change"):
                        now = props.change_brief(s, p.content["change_id"])
                    if now:
                        p = replace(p, content={**p.content, "status_now": now})
                        if now not in seen:
                            seen.add(now)
                            notes.append(f"- {now}")
                parts.append(p)
            m = replace(m, parts=parts)
        out.append(m)
    for p in s.scalars(select(ChatProposal).where(ChatProposal.thread_id == tid)
                       .order_by(ChatProposal.created_at.desc()).limit(10)):
        line = f"- {props.brief(s, p)}"
        if line not in notes:
            notes.append(line)
    return out, "\n".join(notes[-12:])


def _strip_turn_claims(messages: list[ModelMessage], start: int) -> list[ModelMessage]:
    """The stream's claim rule on this turn's stored replies: each response is judged with what
    had landed before it (by earlier steps' tool results), because the stream decided the same
    way, text before its own tool calls included. Never with end-of-turn knowledge."""
    landed: set[str] = set()
    out = list(messages)
    for i in range(start, len(out)):
        m = out[i]
        if isinstance(m, ModelResponse):
            if any(isinstance(p, TextPart) for p in m.parts):
                out[i] = replace(m, parts=[replace(p, content=claims.strip(p.content, landed)[0])
                                           if isinstance(p, TextPart) else p for p in m.parts])
        elif isinstance(m, ModelRequest):
            for p in m.parts:
                if isinstance(p, ToolReturnPart):
                    landed |= landed_kinds(p.tool_name, p.content)
    return out


PREAMBLE_MAX_WORDS = 40


def error_kind(text: str) -> str:
    """What went wrong, for the log line; the athlete only ever sees `plain_error`."""
    status_code = re.search(r"status_code: (\d+)", text)
    code = int(status_code[1]) if status_code else None
    if code in (401, 403):
        return "provider_auth"
    if code == 429:
        return "provider_rate_limit"
    if "request_limit" in text:
        return "step_limit"
    if "exceeded max retries" in text:
        return "tool_retries"
    return "error"


_PLAIN_ERRORS = {
    "provider_auth": "The assistant isn't available right now. Try again later.",
    "provider_rate_limit": "The model provider's usage limit was reached. Try again later.",
    "step_limit": "The assistant reached its step limit. Try a more focused question.",
    "tool_retries": "The assistant couldn't complete that request after several tries. Check your plan, then "
                    "try again with a simpler or more specific request.",
}


def plain_error(text: str) -> str:
    """The run's error as a sentence for the athlete: no provider body, key names or settings."""
    return _PLAIN_ERRORS.get(error_kind(text), "The assistant couldn't answer. Please try again.")


class ChatEventStream(VercelAIEventStream):
    """The Vercel event stream, but a failed turn leaves a trace and the athlete gets plain copy."""

    async def on_error(self, error: Exception):
        # No exc_info: the exception text can hold the provider's response body. Type, status code and
        # the stack go in (llm.scrubbed_traceback), the message never does.
        log.warning("assistant turn failed", extra={
            "event": "chat.turn_failed", "error_type": type(error).__name__, "kind": error_kind(str(error)),
            "status_code": getattr(error, "status_code", None), "exc": scrubbed_traceback(error)})
        async for chunk in super().on_error(error):
            yield ErrorChunk(error_text=plain_error(str(error))) if isinstance(chunk, ErrorChunk) else chunk


@dataclass
class ChatAdapter(VercelAIAdapter):
    """The AI SDK adapter, with the model-facing messages given by the server: the athlete's turn
    is built there (attachments fenced as data, images), so nothing the client put in its message
    parts or history (assistant, system, file or tool-result parts) can reach the model."""

    turn: list[ModelMessage] = field(default_factory=list)

    @property
    def messages(self) -> list[ModelMessage]:  # type: ignore[override]
        return self.turn

    def build_event_stream(self) -> ChatEventStream:
        return ChatEventStream(self.run_input, accept=self.accept, sdk_version=self.sdk_version,
                               server_message_id=self.server_message_id)


def is_preamble(text: str) -> bool:
    """Short step narration before a tool call: no question, at most a couple of lines."""
    return len(text.split()) <= PREAMBLE_MAX_WORDS and "?" not in text


def _drop_preambles(messages: list[ModelMessage], start: int) -> list[ModelMessage]:
    """This turn's stored responses without the text parts that only narrate the next tool call."""
    out = list(messages)
    for i in range(start, len(out)):
        m = out[i]
        if not isinstance(m, ModelResponse) or not any(isinstance(p, ToolCallPart) for p in m.parts):
            continue
        last_call = max(j for j, p in enumerate(m.parts) if isinstance(p, ToolCallPart))
        parts = [p for j, p in enumerate(m.parts)
                 if not (isinstance(p, TextPart) and j < last_call and is_preamble(p.content))]
        if len(parts) != len(m.parts):
            out[i] = replace(m, parts=parts)
    return out


_turn_locks: dict[int, threading.Lock] = {}


class Turn:
    """The user's one-turn-at-a-time lock, taken in the handler (before any await) and released
    exactly once: by the stream's `finally`, by the response's background task, or on any early
    return. A threading lock, so the check-and-take is atomic."""

    def __init__(self, uid: int):
        self.lock = _turn_locks.setdefault(uid, threading.Lock())
        self.held = self.lock.acquire(blocking=False)
        self.streaming = False

    def release(self) -> None:
        if self.held:
            self.held = False
            self.lock.release()


def turn_in_progress() -> JSONResponse:
    return error_response(409, "turn_in_progress", "Wait for the current answer to finish.")


@router.post("")
async def chat(request: Request):
    if not chat_agent.configured():
        return error_response(503, "assistant_unavailable", "The assistant is not configured (no model key). "
                              "Everything else keeps working.")
    uid = request.scope["state"]["user_id"]
    with db.auth_db().session() as s:
        user = s.get(User, uid)
        if user.assistant_consent_at is None:
            return error_response(403, "consent_required", "Confirm how the assistant handles your data first.",
                                  note=CONSENT_NOTE)
    turn = Turn(uid)
    if not turn.held:
        return turn_in_progress()
    try:
        resp = await _chat(request, uid, turn)
    except BaseException:
        turn.release()
        raise
    if not turn.streaming:
        turn.release()
    return resp


async def _chat(request: Request, uid: int, turn: Turn):
    raw = await request.body()
    try:
        body = json.loads(raw)
    except ValueError as e:
        raise HTTPException(422, {"code": "bad_json"}) from e
    tid = str(body.get("id") or "")[:64]
    scope = body.get("scope") if isinstance(body.get("scope"), dict) else {}
    text = _first_text(body)
    att_ids = body.get("attachments") if isinstance(body.get("attachments"), list) else []
    if not tid or not (text or att_ids):
        raise HTTPException(422, {"code": "message_required"})
    if (denied := limits.admit(uid)) is not None:
        return denied

    # One short DB phase; the session is closed before the (slow) model call.
    with db.get_db().session() as s:
        try:
            files = attachments.load(s, att_ids)
        except attachments.AttachmentError as e:
            return attachments.refuse(str(e))
        c = s.get(Conversation, tid)
        if c is None:
            c = Conversation(id=tid, title="New chat", history="[]", scopes={})
            s.add(c)
        history = ModelMessagesTypeAdapter.validate_json(c.history or "[]")
        n_user = sum(1 for m in history if _typed(m))
        sent = {**scope, "sent_at": utcnow().isoformat() + "Z"}
        if files:
            sent["attachments"] = [attachments.brief(f) for f in files]
        c.scopes = {**(c.scopes or {}), str(n_user): sent}
        if c.title == "New chat":
            label = text or files[0].filename
            c.title = (label[:60] + "…") if len(label) > 60 else label
        c.updated_at = utcnow()
        c.model = settings().model
        history, replay_note = replay(s, tid, history)
        content = attachments.user_content(text or "(see the attached files)", files)
        s.commit()

    if not limits.SLOTS.acquire():
        return limits.busy()
    released = False

    def release() -> None:
        nonlocal released
        if not released:
            released = True
            limits.SLOTS.release()

    try:
        # The run input is rebuilt from what the server validated, never the client's message.
        run_body = {"trigger": "submit-message", "id": tid,
                    "messages": [{"id": "turn", "role": "user", "parts": [{"type": "text", "text": text or "(attachments)"}]}]}
        adapter = ChatAdapter(agent=chat_agent.agent(), run_input=VercelAIAdapter.build_run_input(
            json.dumps(run_body).encode()), sdk_version=SDK, accept=request.headers.get("accept"),
            turn=[ModelRequest(parts=[UserPromptPart(content=content)])])
        deps = ChatDeps(conversation_id=tid, turn_id=f"turn-{uuid.uuid4().hex[:10]}", scope=scope,
                        now_local=clock.now().strftime("%a %-d %b %Y %H:%M"), replay=replay_note,
                        user_text=text or "")
        start = len(history)
    except Exception:
        release()
        raise

    async def on_complete(result: Any):
        # `all_messages()` is what the model saw: ProcessHistory rewrites the run's messages in
        # place, so it is the TRIMMED history. Store the complete history we sent plus this turn
        # (from the last typed prompt on), and strip this turn's preambles and claims from that.
        messages = turn_history(history, result.all_messages())
        messages = _drop_preambles(messages, start)
        messages = _strip_turn_claims(messages, start)
        with db.get_db().session() as s:
            c = s.get(Conversation, tid)
            if c is not None:
                c.history = ModelMessagesTypeAdapter.dump_json(attachments.slim(messages)).decode()
                c.updated_at = utcnow()
                s.commit()

    filters: dict[str, claims.ClaimFilter] = {}

    def emit(ev) -> list:
        """Claim filtering on text; everything else passes."""
        if isinstance(ev, TextDeltaChunk):
            out = filters.setdefault(ev.id, claims.ClaimFilter(deps.landed)).feed(ev.delta)
            return [TextDeltaChunk(id=ev.id, delta=out)] if out else []
        if isinstance(ev, TextEndChunk) and ev.id in filters:
            rest = filters.pop(ev.id).end()
            return ([TextDeltaChunk(id=ev.id, delta=rest)] if rest else []) + [ev]
        return [ev]

    counted: list[int] = []

    async def guarded():
        held: list = []  # a text part being held: [start, deltas…, end?] — a possible preamble
        try:
            counted.append(1)  # the model call starts here: the turn counts, even if the client aborts
            async for ev in adapter.run_stream(message_history=history, deps=deps, on_complete=on_complete,
                                               usage_limits=UsageLimits(request_limit=settings().assistant_max_steps)):
                if held:
                    hid, ended = held[0].id, isinstance(held[-1], TextEndChunk)
                    text = "".join(c.delta for c in held if isinstance(c, TextDeltaChunk))
                    if not ended and isinstance(ev, (TextDeltaChunk, TextEndChunk)) and ev.id == hid:
                        held.append(ev)
                        if is_preamble(text + getattr(ev, "delta", "")):
                            continue
                    elif ended and isinstance(ev, (ToolInputStartChunk, ToolInputAvailableChunk)):
                        held = []  # narration right before a tool call: the step row says it
                    else:
                        held.append(ev)
                    if held:
                        for c in held:
                            for out in emit(c):
                                yield out
                        held = []
                        continue
                if isinstance(ev, TextStartChunk):
                    held = [ev]
                    continue
                for out in emit(ev):
                    yield out
            for c in held:
                for out in emit(c):
                    yield out
        finally:
            if counted:
                with db.auth_db().session() as s:
                    accounts.record_turn(s, uid)
            release()
            turn.release()

    from starlette.background import BackgroundTask

    resp = adapter.streaming_response(guarded())
    resp.background = BackgroundTask(lambda: (release(), turn.release()))
    turn.streaming = True
    return resp


# ------------------------------------------------------------------ proposals

def _proposal_call(fn, pid: str, db_: Session):
    try:
        return fn(db_, props.get(db_, pid))
    except props.ProposalError as e:
        return error_response(e.status_code, e.code, e.detail, **e.extra)


@router.get("/proposals/{pid}")
def get_proposal(pid: str, db_: Session = Depends(get_session)):
    return _proposal_call(props.view, pid, db_)


@router.post("/proposals/{pid}/apply")
def apply_proposal(pid: str, db_: Session = Depends(get_session)):
    """Apply by id only: the stored ops, version-checked; 409 `stale` if anything moved on."""
    return _proposal_call(props.apply, pid, db_)


@router.post("/proposals/{pid}/discard")
def discard_proposal(pid: str, db_: Session = Depends(get_session)):
    return _proposal_call(props.discard, pid, db_)
