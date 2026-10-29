"""Tool-argument errors: readable retry messages, forgiving schemas, graceful end (chat/errors.py)."""

import json

from pydantic import ConfigDict, TypeAdapter, ValidationError, create_model
from test_chat import call, chat_client, outputs, post_chat, say, scripted, send, streamed_text  # noqa: F401 (fixture)

from chat.api import plain_error


def _tool_errors(events):
    return [e["errorText"] for e in events if e.get("type") in ("tool-output-error", "tool-input-error")]


def test_trimmed_call_arguments_keep_the_shape_the_tool_accepts():
    from pydantic_ai.messages import ToolCallPart

    from chat import trim

    ds = [{"name": "d", "kind": "daily", "start": "-90d"}] * 5
    args = {"question": "q" * 300, "code": "print(1)\n" * 80, "datasets": ds}
    out = trim._stub_call(ToolCallPart("run_analysis", args, tool_call_id="c1"))
    data = json.loads(out.args)
    assert set(data) == {"question", "code", "datasets"}  # no invented key, none dropped
    assert len(data["datasets"]) == trim.KEEP_ITEMS and data["question"].endswith("[shortened]")
    assert "trimmed" not in out.args
    small = ToolCallPart("get_calendar", {"start": "a"}, tool_call_id="c2")
    assert trim._stub_call(small) is small
    assert trim._stub_call(ToolCallPart("x", "{not json" + "x" * 500, tool_call_id="c3")).args == "{}"


def test_validation_errors_become_short_sentences():
    from chat.errors import describe
    from chat.tools import Op

    model = create_model("A", __config__=ConfigDict(extra="forbid"), question=(str, ...), code=(str, ...), datasets=(list, ...))
    given = {"trimmed": "older call arguments omitted"}
    try:
        model.model_validate(given)
    except ValidationError as e:
        text = describe(e, "run_analysis", given, ["question", "code", "datasets"])
    assert "question is required" in text and "trimmed is not a field here" in text
    assert "abbreviated copy" in text and "Required arguments: question, code, datasets" in text
    assert "```" not in text and '"loc"' not in text and len(text) < 500

    try:
        TypeAdapter(list[Op]).validate_python([{"op": "nope", "x": 1}])
    except ValidationError as e:
        assert "unknown op 'nope'" in describe(e, "change", {}, [])


def test_op_is_inferred_only_when_the_payload_is_unambiguous():
    from chat.tools import infer_op

    add = {"date": "2026-10-20", "title": "Easy run", "type": "run", "items": []}
    assert infer_op(add)["op"] == "add_workout" and "op" not in add
    assert infer_op({"id": "w1", "fields": {"title": "x"}})["op"] == "update_workout"
    assert infer_op({"op": "Add", **add})["op"] == "add_workout"
    assert infer_op({"op": "move-workout", "id": "w1"})["op"] == "move_workout"
    assert "op" not in infer_op({"id": "w1", "date": "2026-10-20"})  # a move or a log: validation says so


def test_example_1_trimmed_arguments_are_rejected_readably_and_the_model_recovers(chat_client):
    client, ca = chat_client
    seen: list = []
    good = {"question": "HRV trend", "code": "print(1)", "datasets": [{"name": "d", "kind": "daily", "start": "-30d"}]}
    model = scripted([call("run_analysis", {"trimmed": "older call arguments omitted"}),
                      call("run_analysis", good, cid="c2"),
                      say("Here is the HRV trend.")], seen)
    with ca.agent().override(model=model):
        events = send(client, "chart my hrv")
    (err,) = _tool_errors(events)
    assert "question is required" in err and "```" not in err and "{" not in err
    messages, _ = seen[1]  # what the model read after the rejection
    retry = [p.model_response() for m in messages for p in m.parts if type(p).__name__ == "RetryPromptPart"]
    assert len(retry) == 1 and "Required arguments" in retry[0] and "validation error" not in retry[0]
    assert len(outputs(events)) == 1 and "HRV trend" in streamed_text(events)  # auto-continuation kept
    assert not [e for e in events if e.get("type") == "error"]


def test_example_2_a_missing_op_is_inferred_and_the_change_lands(chat_client):
    client, ca = chat_client
    ops = [{"date": "2026-10-20", "items": [{"duration_min": 30, "exercise_id": "easy-run"}],
            "title": "Easy run", "type": "run"}]
    with ca.agent().override(model=scripted([call("change", {"ops": ops, "reason": "Asked"}), say("Added.")])):
        events = send(client, "add an easy run tuesday")
    (out,) = outputs(events)
    assert out["saved"] is True and not _tool_errors(events)


def test_example_2_an_unknown_exercise_lists_the_close_ones(chat_client):
    client, ca = chat_client
    ops = [{"op": "add_workout", "date": "2026-10-20", "title": "Run", "type": "run",
            "items": [{"exercise_id": "run", "duration_min": 30}]}]
    with ca.agent().override(model=scripted([call("change", {"ops": ops, "reason": "x"}), say("Sorry.")])):
        events = send(client, "add a run")
    (out,) = outputs(events)
    assert out["error"] == "exercise_not_found" and "easy-run" in out["detail"] and "Don't create" in out["next"]


def test_exercise_search_falls_back_to_the_closest_names(chat_client):
    from chat.tools import list_exercises

    out = list_exercises(None, "running")  # type: ignore[arg-type]
    assert out["exercises"] == [] and "easy-run" in [e["id"] for e in out["similar"]]
    assert "similar" not in list_exercises(None, "run")  # type: ignore[arg-type]
    none = list_exercises(None, "zzzzqq")  # type: ignore[arg-type]
    assert none["similar"] == [] and "ask the athlete" in none["note"]


def test_a_call_that_never_validates_ends_with_a_plain_sentence_not_a_dump(chat_client):
    client, ca = chat_client
    bad = [call("run_analysis", {"trimmed": "x"}, cid=f"c{i}") for i in range(6)]
    with ca.agent().override(model=scripted(bad)):
        r = post_chat(client, "chart my hrv")
    events = [json.loads(line[6:]) for line in r.text.splitlines()
              if line.startswith("data: ") and line[6:].strip() not in ("", "[DONE]")]
    (err,) = [e for e in events if e.get("type") == "error"]
    assert "several tries" in err["errorText"] and "run_analysis" not in err["errorText"]
    assert plain_error("Tool 'x' exceeded max retries count of 3") == err["errorText"]
