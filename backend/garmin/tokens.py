"""The current user's Garmin tokens, encrypted at rest (Fernet) as `users/<id>/garmin/tokens.enc`.

The key is a file named by GARMIN_TOKEN_KEY_FILE (compose.yml: ./secrets/garmin_token.key,
mounted read-only and kept outside the data volume), so a backup of the data holds only
ciphertext. Losing the key costs a reconnect, never data. Without a readable, valid key every
call here raises KeyMissing: Garmin connect and sync fail closed and nothing else is affected.

Tokens go to garminconnect as a JSON string, never a path, so the library has no file to
write plaintext back to when it refreshes them; the caller saves `client.dumps()` instead.
A legacy plaintext `tokens.json` is encrypted into `tokens.enc` and deleted on first load.
"""

from __future__ import annotations

import os
from pathlib import Path

from cryptography.fernet import Fernet, InvalidToken

from core.settings import settings
from db import data_dir

KEY_HELP = "Garmin sync is off: the server's token key is missing or invalid."
UNREADABLE_HELP = (
    "Garmin sync is off: the server cannot read its stored Garmin sign-in. "
    "Check the file permissions or reconnect in Settings → Connections."
)


class KeyMissing(RuntimeError):
    """No usable encryption key: Garmin tokens can be neither read nor written."""

    def __init__(self):
        super().__init__(KEY_HELP)


def _fernet() -> Fernet:
    key_file = settings().garmin_token_key_file
    if key_file is None:
        raise KeyMissing()
    try:
        return Fernet(key_file.read_bytes().strip())
    except (OSError, ValueError) as e:  # unreadable, or not a Fernet key
        raise KeyMissing() from e


def available() -> bool:
    try:
        _fernet()
        return True
    except KeyMissing:
        return False


def _dir() -> Path:
    p = data_dir() / "garmin"
    p.mkdir(parents=True, exist_ok=True)
    return p


def path() -> Path:
    return _dir() / "tokens.enc"


def legacy_path() -> Path:
    return _dir() / "tokens.json"


def present() -> bool:
    """Tokens are stored (encrypted, or still the legacy plaintext awaiting migration)."""
    try:
        return path().exists() or legacy_path().exists()
    except OSError:  # an unreadable folder must not take the status endpoint down
        return False


def save(token_json: str) -> None:
    """Encrypt and write atomically, mode 0600 from creation (never briefly readable)."""
    blob = _fernet().encrypt(token_json.encode())
    target = path()
    tmp = target.with_name(f".{target.name}.{os.getpid()}.tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(blob)
        os.chmod(tmp, 0o600)
        tmp.replace(target)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise


def load() -> str | None:
    """The decrypted token JSON, or None when none are stored or they can't be decrypted
    (a different key: the athlete reconnects). Raises KeyMissing without a key."""
    f = _fernet()
    old = legacy_path()
    if old.exists():  # migrate: encrypt the plaintext, then remove it
        save(old.read_text())
        old.unlink()
    p = path()
    if not p.exists():
        return None
    try:
        return f.decrypt(p.read_bytes()).decode()
    except InvalidToken:
        return None


def delete() -> None:
    path().unlink(missing_ok=True)
    legacy_path().unlink(missing_ok=True)
