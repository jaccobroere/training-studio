"""The assistant: one Pydantic AI agent (model from chat/llm.py) with the plan, data and research tools.

Static instructions carry the policy and the coaching-guide index; per-turn instructions carry
the date table, the captured scope, the Profile, and the current status of this thread's
earlier proposals and changes. Records are fetched through tools, never dumped into the prompt.
"""

from __future__ import annotations

from datetime import timedelta
from functools import lru_cache

from pydantic_ai import Agent, RunContext
from pydantic_ai.capabilities import ProcessHistory
from pydantic_ai.models import Model
from pydantic_ai.models.openai import OpenAIChatModelSettings
from sqlalchemy import func, select

import db
from chat import llm
from chat.analysis_tools import ANALYSIS_TOOLS
from chat.errors import FriendlyToolErrors
from chat.health_tools import HEALTH_TOOLS
from chat.llm import build_model, prompt
from chat.research_tools import RESEARCH_TOOLS
from chat.tools import PLAN_TOOLS, ChatDeps, guide_index, profile_is_empty
from chat.trim import trim_history
from core.settings import settings
from plan import clock
from plan.changes import current_profile, monday_of

POLICY = prompt("system")  # sent as written; {guide} is replaced by the guide index


@lru_cache(maxsize=1)
def model() -> Model:
    return build_model()


def configured() -> bool:
    return llm.configured()


def data_line() -> str:
    from models import Activity, DailyMetric

    with db.get_db().session() as s:
        n_act, last_act = s.execute(select(func.count(), func.max(Activity.local_date))).one()
        last_day = s.scalar(select(func.max(DailyMetric.day)))
        demo = s.scalar(select(func.count()).select_from(Activity).where(Activity.source == "demo"))
    if not n_act and not last_day:
        return "Recorded data: none yet — say so if asked about history; never invent numbers."
    note = " This is synthetic DEMO data, not real measurements — say so." if demo else ""
    return f"Recorded data: {n_act} activities (latest {last_act}); daily wellness through {last_day}.{note}"


def date_table() -> str:
    """Weekday-resolved dates for last week through three weeks ahead."""
    today = clock.today()
    m0 = monday_of(today)
    rows = []
    for w in range(-1, 4):
        m = m0 + timedelta(weeks=w)
        name = {-1: "last week", 0: "this week", 1: "next week"}.get(w, f"in {w} weeks")
        days = ", ".join((m + timedelta(days=i)).strftime("%a %Y-%m-%d") for i in range(7))
        rows.append(f"- {name} (week {m.isocalendar()[1]}): {days}")
    return "\n".join(rows)


def context_block(deps: ChatDeps) -> str:
    sc = deps.scope or {}
    today = clock.today()
    lines = [f"Now: {deps.now_local} (athlete's timezone). Today is {today.strftime('%A %Y-%m-%d')}.",
             "Dates:", date_table()]
    if sc.get("page"):
        lines.append(f"Current screen: {sc['page']}.")
    if sc.get("monday"):
        lines.append(f"The athlete is looking at the week of {sc['monday']}.")
    if sc.get("from") and sc.get("to"):
        lines.append(f"The athlete is looking at weeks {sc['from']} to {sc['to']}.")
    if sc.get("workout"):
        lines.append(f"Selected workout: {sc['workout']}.")
    if sc.get("activity"):
        lines.append(f"The athlete has the recording {sc['activity']} open on the Activities page.")
    if sc.get("selection"):
        lines.append(f"Selected workouts: {sc['selection']}.")
    lines.append(data_line())
    if deps.replay:
        lines.append("Earlier in this thread (status now):\n" + deps.replay)
    with db.get_db().session() as s:
        doc = current_profile(s)
    if doc is None or profile_is_empty(doc.markdown):
        v = doc.version if doc else "none"
        lines.append(f"The Profile is EMPTY (version {v}): begin with the short interview unless the athlete "
                     "asks something else first.")
    else:
        lines.append(f"<profile version=\"{doc.version}\">\n{doc.markdown}\n</profile>")
    return "\n".join(lines)


@lru_cache(maxsize=1)
def agent() -> Agent[ChatDeps, str]:
    model_settings = OpenAIChatModelSettings(openai_reasoning_effort=settings().ollama_reasoning_effort)  # type: ignore[typeddict-item]
    a: Agent[ChatDeps, str] = Agent(model(), deps_type=ChatDeps, instructions=POLICY.replace("{guide}", guide_index()),
                                    tools=[*PLAN_TOOLS, *HEALTH_TOOLS, *RESEARCH_TOOLS, *ANALYSIS_TOOLS],
                                    retries=3, model_settings=model_settings,
                                    capabilities=[ProcessHistory(trim_history), FriendlyToolErrors()])

    @a.instructions
    def _context(ctx: RunContext[ChatDeps]) -> str:
        return context_block(ctx.deps)

    return a
