"""Entry point: `uv run caller`."""

from __future__ import annotations

import asyncio
import logging
import sys

from .config import CALLER_DIR, Config, load_config
from .dialer import DryRunDialer, ElevenLabsDialer
from .framelog import FrameLog
from .handler import CallHandler
from .hub import HubClient

log = logging.getLogger("caller")


def build_dialer(cfg: Config):
    if cfg.dry_run:
        return DryRunDialer()
    missing = cfg.missing_for_real_calls()
    if missing:
        raise SystemExit(f"CALLER_DRY_RUN=0 but these are not set in the root .env: {', '.join(missing)}")
    return ElevenLabsDialer(
        cfg.elevenlabs_api_key,
        cfg.caller_agent_id,
        cfg.phone_number_id,
        api_base=cfg.api_base,
        timeout_s=cfg.call_timeout_s,
        poll_interval_s=cfg.poll_interval_s,
    )


async def amain(cfg: Config) -> None:
    frame_log = FrameLog(CALLER_DIR / "logs")
    log.info("frame log: %s", frame_log.path)
    hub: HubClient | None = None

    async def send(frame: dict) -> None:
        assert hub is not None
        await hub.send(frame)

    handler = CallHandler(build_dialer(cfg), cfg.allowlist, send)

    async def on_frame(frame: dict) -> None:
        if frame.get("type") == "call":
            await handler.on_call(frame)
        # Every other type is ignored, per the contract.

    hub = HubClient(cfg.hub_url, cfg.hub_token, on_frame, frame_log)
    try:
        await hub.run()
    finally:
        frame_log.close()


def main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        stream=sys.stderr,
    )
    cfg = load_config()
    mode = "DRY RUN (no real calls)" if cfg.dry_run else "LIVE (real calls via ElevenLabs + Twilio)"
    log.info("caller starting: %s; allowlist has %d number(s)", mode, len(cfg.allowlist))
    if not cfg.allowlist:
        log.warning("CALL_ALLOWLIST is empty: every call will be refused as not_allowed")
    if not cfg.hub_token:
        log.warning("HUB_TOKEN is empty")
    try:
        asyncio.run(amain(cfg))
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
