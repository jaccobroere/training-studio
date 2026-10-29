"""Human-chosen secrets: hashed slowly, salted per password, and rationed.

Threat model: one box, no email, a handful of users.

Compare session tokens (accounts/service.py), the opposite case for the opposite input.
There, an unsalted single-round sha256 is *correct*, because the thing being hashed is a
128-bit CSPRNG token: there is no dictionary to try and no rainbow table worth building. Here
the input is a word a person picked, so both of those assumptions invert and so does every
decision:

- **Slow and memory-hard.** argon2id, at OWASP's low-memory profile (m=19 MiB, t=2, p=1).
  Roughly 40 ms per verification, which is ~10^6 times the cost of the sha256 next door, and
  that ratio is the entire point.
- **Salted, per password, automatically.** `PasswordHasher.hash()` draws a fresh 16-byte salt
  each call and embeds it in the PHC string with the parameters. We never generate, store or
  compare a salt ourselves; the one `password_hash` column holds all of it.
- **Upgradable without a migration.** Because the parameters live inside the string,
  `needs_rehash()` can spot an old-cost hash at login and quietly re-hash it. Raising the cost
  later, or moving off argon2id entirely, needs no flag day.

**No pepper, deliberately.** A pepper only pays off when the database leaks and the
application secret does not — but here the SQLite file and any `.env` holding the pepper sit
on the same server, in the same tree, read by the same container. Meanwhile nothing in this repo
generates, syncs or backs up those `.env` files, and with no email address there is no password
reset: losing the pepper would not mean "everyone resets", it would mean every account is dead
forever. The trade is bad in both directions, so it is not made.

The other half of this module is **rationing**, which a deliberately expensive KDF makes
mandatory rather than optional. 40 ms of CPU and 19 MiB per call is a weapon pointed at
ourselves: unbounded, a hundred concurrent guesses would claim ~2 GB and pin every core, and
ordinary requests would stall behind them. So both `hash` and `verify` run threaded and
behind the same small semaphore, and both *shed* rather than queue — a growing queue is only a
slower way to run out of memory, and a single-threaded event loop given a plain synchronous
call would have blocked on it regardless of any rate limit upstream. Callers are expected to
have spent a rate-limit budget before they get here; this is the floor under that, not a
substitute for it.
"""

from __future__ import annotations

import asyncio
import re
import unicodedata

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError, VerifyMismatchError

#: OWASP's first recommended argon2id profile: m=19456 KiB, t=2, p=1. The low-memory option of
#: the two equivalent ones, chosen because this box shares four cores with every other app on
#: it — see the module docstring on rationing.
_hasher = PasswordHasher(memory_cost=19456, time_cost=2, parallelism=1)

#: At most this many verifications run at once, so hashing can never claim more than
#: ~2 cores and ~38 MiB however hard the endpoint is hammered. Acquired without waiting:
#: over the limit, the caller is turned away immediately.
MAX_CONCURRENT_HASHES = 2
_slots = asyncio.Semaphore(MAX_CONCURRENT_HASHES)


class Busy(Exception):
    """All hashing slots are taken. The caller should answer 429, not queue."""


#: Verified against when no such user exists, so a login against an unknown username costs the
#: same ~40 ms as one against a real account. Without this, response time alone tells an
#: attacker which usernames are worth attacking. The plaintext is irrelevant and never matches.
DUMMY_HASH = _hasher.hash("training-studio-dummy-verification-target")

ACCOUNT_PASSWORD_MIN = 10
#: Both kinds. Capped before hashing so an oversized body can never reach the KDF at all.
PASSWORD_MAX = 128

USERNAME_MIN = 3
USERNAME_MAX = 32
_USERNAME_RE = re.compile(r"^[a-z0-9._-]+$")


def canonical_username(raw: str) -> str:
    """The lookup form of a username: NFKC-normalised, stripped, casefolded.

    Order matters. Normalising first collapses the compatibility tricks (full-width characters,
    ligatures) that would otherwise produce two visually identical accounts; casefolding then
    makes "Alex" and "alex" one account. `valid_username` restricts the *result* to ASCII,
    which is what closes the remaining homograph and dotless-ı cases — checking the raw input
    instead would let them slip past the unique index.
    """
    return unicodedata.normalize("NFKC", raw).strip().casefold()


def valid_username(canonical: str) -> bool:
    """Is this canonical username acceptable? Call on the output of `canonical_username`."""
    return (
        USERNAME_MIN <= len(canonical) <= USERNAME_MAX
        and _USERNAME_RE.fullmatch(canonical) is not None
    )


async def hash_password(password: str) -> str:
    """A complete argon2id PHC string, salt and parameters included.

    Async, threaded and rationed for exactly the same reason `verify` is: hashing costs the
    same ~40ms of CPU as verifying, and a plain synchronous call here would block the single
    event loop for that long on every registration, rehash and password change — no
    concurrency cap and no thread offload, on the same box that carries `verify`'s docstring
    explaining why both are mandatory. A burst of concurrent registrations would have frozen
    the whole app, not just the auth routes, for anyone else waiting on a request at the
    same moment.
    """
    if _slots.locked():
        raise Busy()

    async with _slots:
        return await asyncio.to_thread(_hasher.hash, password)


def needs_rehash(stored: str) -> bool:
    """Was this hash made with weaker parameters than we use now?"""
    try:
        return _hasher.check_needs_rehash(stored)
    except InvalidHashError:
        return False


async def verify(stored: str | None, password: str) -> bool:
    """Check a password against a stored hash, under the concurrency cap.

    `stored` may be None (an unknown user) — in which case a verification is
    still burned against `DUMMY_HASH` before answering False, so an unknown user and a wrong
    password cost the same. Raises `Busy` when every slot is taken.

    The check-then-acquire is safe despite looking racy: asyncio is cooperative and
    single-threaded, and `Semaphore.acquire()` returns without yielding when a slot is free, so
    nothing can interleave between the two lines. Shedding here rather than awaiting is the
    point — see the module docstring.
    """
    if _slots.locked():
        raise Busy()

    async with _slots:
        target = stored or DUMMY_HASH
        # argon2 is CPU-bound C; a thread keeps the event loop answering everything else.
        ok = await asyncio.to_thread(_verify_sync, target, password)
        return ok and stored is not None


def _verify_sync(stored: str, password: str) -> bool:
    try:
        return _hasher.verify(stored, password)
    except (VerifyMismatchError, VerificationError, InvalidHashError):
        return False
