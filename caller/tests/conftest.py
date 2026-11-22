import json
from pathlib import Path

import pytest

CONTRACT = Path(__file__).resolve().parents[2] / "CONTRACT.md"


def contract_section_objects(heading: str) -> list[dict]:
    """Every JSON object in the ```json blocks under one '## ' heading of CONTRACT.md."""
    text = CONTRACT.read_text(encoding="utf-8")
    start = text.index(f"## {heading}")
    end = text.find("\n## ", start + 3)
    section = text[start: end if end != -1 else None]
    objs: list[dict] = []
    decoder = json.JSONDecoder()
    for block in section.split("```json")[1:]:
        body = block.split("```", 1)[0]
        i = 0
        while True:
            while i < len(body) and body[i].isspace():
                i += 1
            if i >= len(body):
                break
            obj, i = decoder.raw_decode(body, i)
            objs.append(obj)
    return objs


@pytest.fixture
def caller_examples() -> list[dict]:
    return contract_section_objects("Caller (stretch)")
