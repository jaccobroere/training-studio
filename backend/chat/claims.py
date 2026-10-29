"""Never let a reply claim a write that didn't happen (port of wbso-tracker's
`strip_app_claims`, deliberately conservative).

A claim says, in the first person past tense, the passive perfect or the bare imperative past
("Moved your long run to Sunday.", "Done —"), that something was written. Three kinds are
tracked separately, because each is only true if *that* kind landed this turn:

- `plan`: the calendar, series, exercises, Profile (a `change` / `undo_change` applied);
- `pin`: a Health → Pinned write (`pin_analysis`, `update_pinned`, `unpin_analysis`);
- `proposal`: "I've drafted / set up a proposal" (a `propose`, or a `change` stored as one).

A pin never makes a plan claim true, and a stored proposal never does either. Analysis output
("I created a chart…") is not a plan write and is never stripped. Offers, plans and questions
("I can add…", "Shall I move…", "If you want, I'll add…") are not claims; modals and "if you"
count only inside the clause that holds the claim, so a later "…and I can add strides" cannot
excuse an earlier "I've moved…". Sentences claiming something that did not land are dropped and
a plain notice per kind is added instead, except that a dropped plan claim gets no "nothing has been
changed" notice when a proposal landed: the proposal card already says nothing is applied until Apply.
A draft is described as a draft ("the draft moves gym to Wednesday"), which is never a claim.

Streaming: `ClaimFilter` sits between the agent's event stream and the client. Text is passed
through sentence by sentence; a false-looking claim (and everything after it in that text part)
is held until the part ends, then released if its kind has landed by then, else dropped. The
stored history gets the same treatment (`strip`), each reply judged with what had landed
before it (`landed_kinds` over earlier tool results), never with end-of-turn knowledge.
"""

from __future__ import annotations

import re
from collections.abc import Callable, Iterable

PLAN, PIN, PROPOSAL = "plan", "pin", "proposal"
PAST = (r"added|moved|updated|saved|scheduled|rescheduled|deleted|removed|created|changed|applied|"
        r"swapped|replaced|edited|skipped|cancell?ed|logged|marked|set up|put|planned|shifted|"
        r"tagged|attached|linked|wrote|written|recorded|inserted|booked|cleared|renamed|extended|"
        r"ended|split|undone|undid|reverted|restored|pinned|unpinned|proposed|drafted|prepared|"
        r"put together")
_CLAIM = re.compile(
    r"(?:\b(?:I|we)(?:'ve|’ve| have)?\s+(?:now\s+|just\s+|also\s+|already\s+|successfully\s+|gone ahead and\s+)?"
    rf"(?P<v1>{PAST})\b"
    rf"|\b(?:has|have)\s+(?:now\s+)?been\s+(?:successfully\s+)?(?P<v2>{PAST})\b"
    rf"|\b(?:is|are)\s+now\s+(?P<v3>{PAST}|in your (?:plan|calendar))\b"
    rf"|^\W*(?:(?:also|now|just|and|sure|ok|okay|great)[\s,]+)*(?P<v4>{PAST})\b"
    r"(?=\s+(?:your|the|a|an|my|our|this|that|these|those|it|them|both|all|\d+|one|two|three|four|five|six)\b"
    r"|\s*[.!—–:-]|\s*$)"
    r"|^\s*(?P<v5>done|saved|all set)\s*[.!—–-])",
    re.IGNORECASE,
)
# Before the claim, inside its own clause: an offer, a plan or a condition, not a report.
_NOT_BEFORE = re.compile(r"\b(?:can|could|would|will|shall|should|might|may|must|whether|unless)\b|'d\b|’d\b|"
                         r"'ll\b|’ll\b|\bif you\b|\bif i\b", re.IGNORECASE)
_NEGATED = re.compile(r"\b(?:not|never|no longer)\s+(?:yet\s+)?$|n't\s+(?:yet\s+)?$", re.IGNORECASE)
_PIN = re.compile(r"\bpin(?:ned|s)?\b|\bunpin\w*|health\b.{0,20}\bpinned|\bpinned board", re.IGNORECASE)
_PROPOSAL = re.compile(r"\bdraft\w*|\bproposal\b|\bpropos\w*", re.IGNORECASE)
_ANALYSIS = re.compile(r"\b(?:chart|graph|plot|analysis|figure|histogram|visuali[sz]ation|diagram|table|summary|"
                       r"breakdown|overview|calculation)s?\b", re.IGNORECASE)
_CLAUSE = re.compile(r"[^,;—–:]+(?:[,;—–:]|$)|[—–]")
_AND = re.compile(r"\s+\b(?:and|but|then|so|while|though)\b\s+", re.IGNORECASE)
_SENTENCE = re.compile(r"[^.!?\n]+(?:[.!?]+|$)[ \t]*|\n")
NOTICES = {PLAN: "Nothing has been changed in your plan yet.", PIN: "Nothing has been pinned yet.",
           PROPOSAL: "No proposal has been created yet."}
NOTICE = NOTICES[PLAN]


def _clauses(sentence: str) -> list[str]:
    out = []
    for c in _CLAUSE.findall(sentence):
        out += [x for x in _AND.split(c) if x.strip()]
    return out


def _kind(clause: str, verb: str) -> str | None:
    """What the claim is about; None for output that isn't a write (a chart, a summary)."""
    v = verb.lower()
    if v in ("proposed", "drafted", "prepared", "put together") or (_PROPOSAL.search(clause) and not _PIN.search(clause)):
        return PROPOSAL
    if _PIN.search(clause):
        return PIN
    if _ANALYSIS.search(clause):
        return None
    return PLAN


def claim_kinds(sentence: str) -> set[str]:
    """The kinds of write this sentence reports as done (empty: no claim)."""
    kinds: set[str] = set()
    if sentence.rstrip().endswith("?"):
        return kinds
    for clause in _clauses(sentence):
        m = _CLAIM.search(clause)
        if not m:
            continue
        before = clause[:m.start()]
        if _NOT_BEFORE.search(before) or _NEGATED.search(clause[:m.start("v1")] if m.group("v1") else before):
            continue
        verb = next((g for g in m.groups() if g), "")
        if (k := _kind(sentence if m.group('v5') else clause, verb)) is not None:
            kinds.add(k)
    return kinds


def is_claim(sentence: str, landed: Iterable[str] = ()) -> bool:
    """True when the sentence claims a kind of write that did not land."""
    return bool(claim_kinds(sentence) - set(landed))


def _clean(text: str, landed: Iterable[str]) -> tuple[str, list[str], bool]:
    """(text without the claims of kinds that didn't land, the notices to add, whether anything
    was dropped). A dropped plan claim gets no "nothing has been changed" notice when a proposal
    landed: the proposal card already says nothing is applied until Apply."""
    landed = set(landed)
    parts = _SENTENCE.findall(text)
    kept, dropped, eat_break = [], [], False
    for p in parts:
        if eat_break and p == "\n":  # a dropped sentence takes its own line break, leaving no blank line
            eat_break = False
            continue
        eat_break = False
        bad = claim_kinds(p) - landed
        if bad:
            dropped += [k for k in (PLAN, PIN, PROPOSAL) if k in bad and k not in dropped]
            eat_break = True
        else:
            kept.append(p)
    if not dropped:
        return text, [], False
    notices = [NOTICES[k] for k in dropped if not (k == PLAN and PROPOSAL in landed)]
    return re.sub(r"\n{3,}", "\n\n", "".join(kept)).strip(), notices, True


def _with_notices(kept: str, notices: list[str]) -> str:
    """The cleaned text with its notices; a reply that was only dropped claims is never empty."""
    notice = " ".join(notices) or (NOTICES[PLAN] if not kept else "")
    return f"{kept}\n\n{notice}" if kept and notice else (kept or notice)


def strip(text: str, landed: Iterable[str] = ()) -> tuple[str, bool]:
    """(text without claims of kinds that didn't land, whether anything was dropped)."""
    out, notices, changed = _clean(text, landed)
    return (_with_notices(out, notices), True) if changed else (text, False)


class ClaimFilter:
    """Per text part: feed deltas, get back what may be sent now; `end()` flushes."""

    def __init__(self, landed: Callable[[], Iterable[str]]):
        self.landed = landed  # callable → kinds of write that landed this turn so far
        self.buf = ""
        self.held = ""

    def feed(self, delta: str) -> str:
        self.buf += delta
        out = ""
        while True:
            m = re.search(r"[.!?]+[ \t]+|\n", self.buf)
            if not m:
                break
            sentence, self.buf = self.buf[:m.end()], self.buf[m.end():]
            if self.held or is_claim(sentence, self.landed()):
                self.held += sentence
            else:
                out += sentence
        return out

    def end(self) -> str:
        rest = self.held + self.buf
        self.held = self.buf = ""
        if not rest:
            return rest
        kept, notices, changed = _clean(rest, self.landed())
        if not changed:
            return rest
        text = _with_notices(kept, notices)
        return text if kept else "\n\n" + text
