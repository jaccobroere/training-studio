"""Every environment variable the app reads, declared once, typed, with its default.

Read through ``settings()``, at use time, never at import: tests and the eval harness change
the environment between cases and call ``reset()``. An empty value counts as unset. A bad
value fails at startup (``main.create_app``) with one error that names every bad variable
and never its value.

The analysis runner (pyrunner/) is a separate service with its own few limits; it doesn't
read this module.
"""

from __future__ import annotations

from datetime import date
from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import Field, SecretStr, ValidationError
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_ignore_empty=True, extra="ignore", frozen=True)

    # Runtime
    app_env: Literal["dev", "test", "production"] = "dev"
    app_version: str = "dev"
    data_dir: Path = Path("data")
    athlete_tz: str = "Europe/Amsterdam"
    # The address users open; only used in the invite message accounts.admin prints.
    public_url: str = "http://localhost:8080"
    fake_today: date | None = None  # pins "today" for demos, tests and evals; never in production
    jobs_enabled: bool = True
    log_level: Literal["DEBUG", "INFO", "WARNING", "ERROR"] = "INFO"
    log_format: Literal["json", "text"] | None = None  # default: text in dev, json otherwise

    # The assistant (Ollama Cloud: chat, web search and fetch)
    ollama_api_key: SecretStr | None = None
    sports_model: str | None = None  # wins over OLLAMA_MODEL
    ollama_model: str = "deepseek-v4.1-flash:1017"
    ollama_base_url: str = "https://ollama.com/v1"
    ollama_web_api: str = "https://ollama.com/api"
    # "low" keeps time-to-first-token short (decision 15)
    ollama_reasoning_effort: Literal["low", "medium", "high"] = "low"
    sports_model_images: bool = True  # false: never send image parts (text-only models)
    assistant_weekly_turns: int = Field(200, ge=0)
    # Turns across ALL accounts per week: one Ollama key is one bill (-1 = no cap)
    assistant_global_weekly_turns: int = Field(1000, ge=-1)
    assistant_per_minute: int = Field(6, ge=1)
    assistant_concurrency: int = Field(4, ge=1)
    assistant_max_steps: int = Field(16, ge=1)  # model requests (tool round-trips) per turn
    assistant_keep_turns: int = Field(4, ge=1)
    assistant_history_chars: int = Field(120_000, ge=1_000)
    sports_analysis_runs_per_turn: int = Field(3, ge=1)

    # The analysis sandbox: required in production, a local limited subprocess elsewhere
    pyrunner_url: str | None = None

    # Garmin sync and media decoding
    garmin_pull_hours: float = Field(2.0, gt=0)
    garmin_pause_s: float = Field(1.0, ge=0)
    media_worker_mem_mb: int = Field(2048, ge=16)
    # Fernet key that encrypts each user's Garmin tokens; kept outside the backups. Unset or
    # unreadable: Garmin connect and sync fail closed, the rest of the app works.
    garmin_token_key_file: Path | None = None

    # Feedback outbox -> an optional webhook (FEEDBACK_WEBHOOK_URL). Empty URL disables
    # forwarding but still stores the feedback locally. A URL without a secret fails
    # closed in the outbox instead of sending unsigned payloads.
    feedback_webhook_url: str | None = None
    feedback_webhook_secret: SecretStr | None = None
    feedback_webhook_timeout_s: float = Field(20.0, gt=0, le=60)
    feedback_daily_limit: int = Field(10, ge=1, le=100)
    # LLM triage before forwarding. Without an Ollama key (tests/dev) this falls back
    # to a deterministic rule-based triage. A slow provider must not hold the queue.
    feedback_enrich: bool = True
    feedback_enrich_timeout_s: float = Field(25.0, gt=0, le=120)

    # Disk: each account's folder (uploads refused past it)
    user_storage_quota_mb: int = Field(4096, ge=1)

    # Runaway alerts: an optional webhook plus the thresholds that trigger it.
    # Unset webhook = the warning is only in the log. See backend/alerts.py.
    alert_webhook_url: str | None = None
    alert_webhook_token: SecretStr | None = None
    alert_failed_runs_per_hour: int = Field(6, ge=1)
    alert_storage_growth_mb: int = Field(500, ge=1)
    alert_free_disk_mb: int = Field(8192, ge=1)

    @property
    def model(self) -> str:
        return self.sports_model or self.ollama_model

    @property
    def api_key(self) -> str | None:
        return self.ollama_api_key.get_secret_value() if self.ollama_api_key else None


class SettingsError(RuntimeError):
    """One or more environment variables are invalid; the message names them, never values."""


def load() -> Settings:
    try:
        return Settings()
    except ValidationError as e:
        names = sorted({str(err["loc"][0]).upper() for err in e.errors() if err["loc"]})
        raise SettingsError(f"invalid environment variables: {', '.join(names)}") from None


def check_production(s: Settings) -> None:
    """Refuse to start a production process that would run model-written code in the app's own
    container (no runner) or pin the date (FAKE_TODAY is for demos, tests and evals). Names the
    variables, never their values."""
    if s.app_env != "production":
        return
    bad = [
        name
        for name, ok in (("PYRUNNER_URL", s.pyrunner_url), ("FAKE_TODAY", s.fake_today is None))
        if not ok
    ]
    if bad:
        raise SettingsError(f"invalid environment for APP_ENV=production: {', '.join(bad)}")


@lru_cache(maxsize=1)
def settings() -> Settings:
    return load()


def reset() -> None:
    """Forget the cached settings, so the next read sees the current environment."""
    settings.cache_clear()
