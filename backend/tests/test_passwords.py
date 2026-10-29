"""accounts/passwords.py: the properties that don't show up in an HTTP-level test.

The whole reason `hash_password` and `verify` are async, threaded and rationed is to protect the
*single event loop* — and a test that just calls them and checks the return value would pass
even if that protection were missing, because argon2 answers the same either way. What matters
here is what happens to everything else running on the process while a hash is in flight, which
is why these tests watch the event loop rather than the return value.

"""

from __future__ import annotations

import asyncio

import argon2

from accounts import passwords


def run(coro):
    """Drive a coroutine to completion, so the suite needs no pytest-asyncio.

    The backend's dev dependency is only pytest; keeping the suite free of an async plugin
    means it still collects with that alone rather than silently skipping.
    """
    return asyncio.run(coro)


def test_a_hashed_password_verifies_and_carries_a_fresh_salt():
    async def scenario():
        a = await passwords.hash_password("a-long-enough-password")
        b = await passwords.hash_password("a-long-enough-password")
        assert a != b, "two hashes of the same password must not be identical"
        assert await passwords.verify(a, "a-long-enough-password") is True
        assert await passwords.verify(a, "something-else") is False

    run(scenario())


def test_stored_hash_pins_the_current_cost():
    """The PHC string is the migration-proof part: pin it so a silent cost change shows up here.

    Lowering it would weaken every future password; raising it deliberately is a decision that
    should update `needs_rehash` expectations and this test together.
    """

    async def scenario():
        stored = await passwords.hash_password("a-long-enough-password")
        assert stored.startswith("$argon2id$v=19$m=19456,t=2,p=1$")

    run(scenario())


def test_hash_password_does_not_block_the_event_loop():
    """A concurrent tick must land almost immediately, not after the hash finishes.

    If `hash_password` called argon2 synchronously on the loop, nothing else could run until it
    returned ~40 ms later — the loop is single-threaded and cooperative, and a plain function
    call holds it for its entire duration. Racing the hash against a task that records *when* it
    got its turn catches that: only a real thread handoff (`await asyncio.to_thread(...)`) yields
    control back early enough for the tick to land a beat later rather than a hash-duration
    later.
    """

    async def scenario():
        loop = asyncio.get_running_loop()
        started = loop.time()
        ticked_at = None

        async def tick():
            nonlocal ticked_at
            ticked_at = loop.time()

        hash_task = asyncio.create_task(passwords.hash_password("a-long-enough-password"))
        tick_task = asyncio.create_task(tick())
        await tick_task
        await hash_task

        elapsed_ms = (ticked_at - started) * 1000
        # argon2id at these parameters costs ~40 ms; a real thread handoff lets the tick through
        # in well under a millisecond. 10 ms is generous headroom above scheduling noise and
        # comfortably below "the hash blocked the loop".
        assert elapsed_ms < 10, (
            f"the tick took {elapsed_ms:.1f}ms to run — the hash blocked the event loop "
            "instead of handing off to a thread"
        )

    run(scenario())


def test_hashing_sheds_rather_than_queues_when_saturated():
    """Every slot taken means `Busy`, immediately — never a wait.

    Simulates saturation directly rather than firing real concurrent hashes at it (slow and
    timing-dependent); the module-level semaphore is the actual mechanism, so holding its slots
    open is a faithful stand-in for "every hash currently in flight".
    """

    async def scenario():
        async with passwords._slots, passwords._slots:
            try:
                await passwords.hash_password("a-long-enough-password")
                assert False, "expected Busy"
            except passwords.Busy:
                pass

    run(scenario())


def test_hash_and_verify_share_one_pool():
    """One budget for both operations, not two independent ones.

    If hashing and verifying drew from separate semaphores, a burst of password changes could
    still starve sign-ins of CPU (or vice versa) even though each individually looked rationed.
    Saturating through `hash_password`'s slots must also turn away `verify`.
    """

    async def scenario():
        async with passwords._slots, passwords._slots:
            try:
                await passwords.verify(None, "a-long-enough-password")
                assert False, "expected Busy"
            except passwords.Busy:
                pass

    run(scenario())


def test_unknown_user_still_spends_a_verification(monkeypatch):
    """A login for a user that does not exist must cost what a real one costs.

    Verified structurally rather than by timing: the call that would have hashed a real password
    must still happen, against the dummy hash, so response time cannot tell an attacker which
    usernames are worth attacking.
    """
    seen: list[tuple[str, str]] = []

    def fake_verify(stored, password):
        seen.append((stored, password))
        return False

    monkeypatch.setattr(passwords, "_verify_sync", fake_verify)

    async def scenario():
        assert await passwords.verify(None, "a-long-enough-password") is False
        assert seen == [(passwords.DUMMY_HASH, "a-long-enough-password")]

    run(scenario())


def test_needs_rehash_spots_a_weaker_hash():
    weak = argon2.PasswordHasher(memory_cost=8192, time_cost=1, parallelism=1)
    assert passwords.needs_rehash(weak.hash("a-long-enough-password")) is True

    async def scenario():
        current = await passwords.hash_password("a-long-enough-password")
        assert passwords.needs_rehash(current) is False

    run(scenario())


def test_a_malformed_stored_hash_answers_false():
    """A corrupt row is a failed sign-in, not a 500 for that account forever."""

    async def scenario():
        assert await passwords.verify("not-a-phc-string", "a-long-enough-password") is False
        bad_params = "$argon2id$v=19$m=x,t=y,p=z$c2FsdA$aGFzaA"
        assert await passwords.verify(bad_params, "a-long-enough-password") is False

    run(scenario())
    assert passwords.needs_rehash("not-a-phc-string") is False
