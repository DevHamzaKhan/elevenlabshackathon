"""E.164 validation and the CALL_ALLOWLIST."""

from __future__ import annotations

import re

E164 = re.compile(r"^\+[1-9]\d{6,14}$")


def is_e164(number: object) -> bool:
    return isinstance(number, str) and bool(E164.fullmatch(number))


def parse_allowlist(raw: str | None) -> frozenset[str]:
    """Comma-separated E.164 numbers. Whitespace is trimmed; invalid entries are dropped."""
    if not raw:
        return frozenset()
    entries = (part.strip() for part in raw.split(","))
    return frozenset(e for e in entries if is_e164(e))


def is_allowed(number: object, allowlist: frozenset[str]) -> bool:
    return is_e164(number) and number in allowlist
