"""Load personal settings from server/.env into environment variables.

.env is git-ignored, so machine-specific values (like a local model path)
stay off GitHub. Real environment variables win over .env values.
Format: one NAME=value per line; # starts a comment. Backslashes are kept
as-is, so Windows paths work without escaping.
"""
import os
from pathlib import Path

ENV_FILE = Path(__file__).parent / ".env"


def load(path: Path = ENV_FILE) -> None:
    if not path.exists():
        return
    for raw in path.read_text(encoding="utf-8-sig").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        name, value = line.split("=", 1)
        name, value = name.strip(), value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        os.environ.setdefault(name, value)


load()
