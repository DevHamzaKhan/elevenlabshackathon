"""Configuration from the environment (repo-root .env, see CONTRACT.md "Configuration")."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

from dotenv import load_dotenv

from .phone import parse_allowlist

# src/caller/config.py -> parents[2] is caller/, parents[3] is the repo root.
CALLER_DIR = Path(__file__).resolve().parents[2]
REPO_ROOT = CALLER_DIR.parent
DEFAULT_HUB_URL = "ws://localhost:8765"


def _truthy(value: str | None, default: bool) -> bool:
    if value is None or value.strip() == "":
        return default
    return value.strip().lower() not in {"0", "false", "no", "off"}


@dataclass(frozen=True)
class Config:
    hub_url: str = DEFAULT_HUB_URL
    hub_token: str = ""
    elevenlabs_api_key: str = field(default="", repr=False)
    caller_agent_id: str = ""
    phone_number_id: str = ""
    allowlist: frozenset[str] = frozenset()
    dry_run: bool = True
    owner_number: str = ""
    api_base: str = "https://api.elevenlabs.io"
    call_timeout_s: float = 180.0
    poll_interval_s: float = 2.0

    def missing_for_real_calls(self) -> list[str]:
        missing = []
        if not self.elevenlabs_api_key:
            missing.append("ELEVENLABS_API_KEY")
        if not self.caller_agent_id:
            missing.append("ELEVENLABS_CALLER_AGENT_ID")
        if not self.phone_number_id:
            missing.append("ELEVENLABS_PHONE_NUMBER_ID")
        return missing


def load_config(env_file: Path | None = None) -> Config:
    """Read the repo-root .env (if present) without overriding real env vars."""
    load_dotenv(env_file or REPO_ROOT / ".env", override=False)
    env = os.environ
    return Config(
        hub_url=env.get("HUB_URL") or DEFAULT_HUB_URL,
        hub_token=env.get("HUB_TOKEN", ""),
        elevenlabs_api_key=env.get("ELEVENLABS_API_KEY", ""),
        caller_agent_id=env.get("ELEVENLABS_CALLER_AGENT_ID", ""),
        phone_number_id=env.get("ELEVENLABS_PHONE_NUMBER_ID", ""),
        allowlist=parse_allowlist(env.get("CALL_ALLOWLIST", "")),
        dry_run=_truthy(env.get("CALLER_DRY_RUN"), default=True),
        owner_number=env.get("OWNER_NUMBER", ""),
        api_base=env.get("CALLER_API_BASE") or "https://api.elevenlabs.io",
        call_timeout_s=float(env.get("CALLER_TIMEOUT_S") or 180),
    )
