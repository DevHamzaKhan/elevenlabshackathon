"""One JSON line per frame sent/received, in caller/logs/ (gitignored)."""

from __future__ import annotations

import json
import time
from pathlib import Path


class FrameLog:
    def __init__(self, directory: Path):
        directory.mkdir(parents=True, exist_ok=True)
        stamp = time.strftime("%Y%m%d-%H%M%S")
        self.path = directory / f"caller-{stamp}.jsonl"
        self._fh = self.path.open("a", encoding="utf-8")

    def write(self, direction: str, frame: object, **extra: object) -> None:
        line = {"at": int(time.time() * 1000), "dir": direction, "msg": frame, **extra}
        self._fh.write(json.dumps(line, ensure_ascii=False) + "\n")
        self._fh.flush()

    def close(self) -> None:
        self._fh.close()


class NullLog:
    path = None

    def write(self, direction: str, frame: object, **extra: object) -> None:
        pass

    def close(self) -> None:
        pass
