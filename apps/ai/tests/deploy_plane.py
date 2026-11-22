"""The deployment plane, read rather than remembered.

`infra/docker-compose.yml` and `apps/ai/Dockerfile` are the files that decide where a container
listens and what its environment says. A test that repeats their contents as literals drifts from
them the moment someone edits the deployment — and stays green doing it, which is the failure mode
D1550 and D1551 are about. Everything here therefore PARSES the deployment and hands back what it
found, so the doors assert against the file the operators actually edit.

Used by tests/test_d1550_container_entry_honours_the_image_contract.py (what the CMD binds) and
tests/test_d1551_ai_block_names_reach_the_ai.py (what the block configures, and whether the AI reads
it under that name).
"""
from __future__ import annotations

import re
import subprocess
from pathlib import Path

AI_DIR = Path(__file__).resolve().parents[1]
REPO = AI_DIR.parents[1]
DOCKERFILE = AI_DIR / "Dockerfile"
COMPOSE = REPO / "infra" / "docker-compose.yml"

# Where a name has to appear for the service to count as reading it. Everything a container can be
# configured through is in this set: the application source, the entrypoint, the image, the build
# manifest. A key that appears in none of them is a key nothing reads.
AI_READER_ROOTS = ("apps/ai/nexus_ai", "apps/ai/app", "apps/ai/start_ai.py",
                   "apps/ai/Dockerfile", "apps/ai/pyproject.toml")


def compose_text_for(service: str) -> str:
    """The slice of `docker-compose.yml` that is one service's mapping, and nothing else."""
    lines = COMPOSE.read_text(encoding="utf-8").splitlines()
    start = None
    for i, raw in enumerate(lines):
        m = re.match(r"^  ([a-z0-9_-]+):$", raw)
        if m and m.group(1) == service:
            start = i
        elif start is not None and i > start and re.match(r"^  [a-z0-9_-]+:$", raw):
            return "\n".join(lines[start:i])
    if start is None:
        raise AssertionError(f"infra/docker-compose.yml has no `{service}:` service")
    return "\n".join(lines[start:])


def compose_environment(service: str) -> dict[str, str]:
    """The `environment:` mapping of one service, with `${X:-default}` resolved to the default.

    The defaults are what the deployment does when the invoking shell does not export an override,
    which is the case a reviewer and a gate can both reproduce.
    """
    out, in_env = {}, False
    for raw in compose_text_for(service).splitlines():
        if re.match(r"^    environment:\s*$", raw):
            in_env = True
            continue
        if in_env:
            k = re.match(r"^      ([A-Z][A-Z0-9_]*):\s*(.*?)\s*(?:#.*)?$", raw)
            if k:
                value = re.sub(r"\$\{[A-Z0-9_]+:-([^}]*)\}", r"\1", k.group(2)).strip('"')
                out[k.group(1)] = value
            elif raw.strip() and not raw.startswith("      "):
                in_env = False
    return out


def dockerfile_env() -> dict[str, str]:
    out = {}
    for m in re.finditer(r"^\s*(NEXUS_AI_HOST|NEXUS_AI_PORT)=([^\s\\]+)",
                         DOCKERFILE.read_text(encoding="utf-8"), re.M):
        out[m.group(1)] = m.group(2)
    return out


def published_container_port(service: str) -> str:
    """The CONTAINER side of a `"127.0.0.1:${HOST_PORT:-x}:<this>"` mapping — what must be bound."""
    m = re.search(r'-\s*"127\.0\.0\.1:.+?:(\d+)"', compose_text_for(service))
    if not m:
        raise AssertionError(f"no published port mapping found for service {service}")
    return m.group(1)


def unread_ai_keys() -> list[tuple[str, str]]:
    """Every `ai:` environment key with no reader in the AI's own source, as (key, value)."""
    import subprocess

    dead = []
    for key, value in sorted(compose_environment("ai").items()):
        r = subprocess.run(["git", "grep", "-l", key, "--", *AI_READER_ROOTS], cwd=REPO,
                           capture_output=True, text=True, encoding="utf-8", errors="replace")
        if not [l for l in r.stdout.splitlines() if l.strip()]:
            dead.append((key, value))
    return dead
