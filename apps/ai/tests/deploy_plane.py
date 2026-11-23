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
CI_WORKFLOW = REPO / ".github" / "workflows" / "ci.yml"


def ci_workflow() -> dict:
    import yaml

    workflow = yaml.safe_load(CI_WORKFLOW.read_text(encoding="utf-8")) or {}
    assert isinstance(workflow.get("jobs"), dict), "ci.yml has no jobs mapping"
    return workflow

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


def services_region() -> list[str]:
    """The lines inside the top-level `services:` mapping, and only those.

    `compose_text_for` matches any two-space key, which is right for a named service but cannot answer
    "what services does this deployment have": the children of the top-level `volumes:` mapping
    (`pgdata:`, `redisdata:`) are the same shape. A census that walked them as services would report
    them as blocks with no reader.
    """
    lines = COMPOSE.read_text(encoding="utf-8").splitlines()
    start = next((i for i, line in enumerate(lines) if line == "services:"), None)
    if start is None:
        raise AssertionError("infra/docker-compose.yml has no `services:` mapping")
    end = next((i for i in range(start + 1, len(lines)) if re.match(r"^[a-z0-9_-]+:$", lines[i])),
               len(lines))
    return lines[start + 1:end]


def compose_services() -> list[str]:
    return [m.group(1) for m in (re.match(r"^  ([a-z0-9_-]+):$", line) for line in services_region()) if m]



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
    dead = []
    for key, value in sorted(compose_environment("ai").items()):
        if not source_names(key, AI_READER_ROOTS):
            dead.append((key, value))
    return dead


# Where each service's configuration is consumed. A key with no hit in its own row's roots is a key that
# service cannot hear. `postgres` and `redis` are upstream images: what they read is their entrypoint
# script, and the only part of that this repo owns is the init SQL bind-mounted at compose:53, so it is
# in the row rather than being waved through as "third-party image".
SERVICE_READER_ROOTS: dict[str, list[str]] = {
    "postgres": ["infra/postgres/init", "infra/db/migrations"],
    "redis": [],
    "platform": ["services/platform/src/main"],
    "ai": list(AI_READER_ROOTS),
    "web": ["apps/web/src", "apps/web/next.config.mjs", "apps/web/package.json"],
    "eureka": ["services/cloud/eureka-server/src/main", "services/cloud/Dockerfile"],
    "config-server": ["services/cloud/config-server/src/main", "services/cloud/Dockerfile"],
    "gateway": ["services/cloud/gateway/src/main", "services/cloud/Dockerfile"],
    "admin-server": ["services/cloud/admin-server/src/main", "services/cloud/Dockerfile"],
    "insight-service": ["services/cloud/insight-service/src/main", "services/cloud/Dockerfile"],
}

# Names a RUNTIME resolves without any source naming them: Spring Boot's relaxed binding (`SPRING_*`,
# `SERVER_PORT`), the Postgres image's own entrypoint (`POSTGRES_*`, `PGDATA`), the container's C
# library (`TZ`) and the Node/JVM launchers. Deliberately narrow: `NEXUS_*` is NOT here, because a
# `NEXUS_` name only means something where a file in the service's own tree spells it out.
FRAMEWORK_CONVENTION = re.compile(r"^(SPRING_|SERVER_PORT$|POSTGRES_|PGDATA$|TZ$|JAVA_|NODE_ENV$)")


def source_names(key: str, roots: list[str]) -> bool:
    """Does any tracked file under these roots spell this name?"""
    if not roots:
        return False
    r = subprocess.run(["git", "grep", "-l", key, "--", *roots], cwd=REPO, stdin=subprocess.DEVNULL,
                       capture_output=True, text=True, encoding="utf-8", errors="replace")
    return any(line.strip() for line in r.stdout.splitlines())


def unread_compose_keys() -> list[tuple[str, str, str]]:
    """Every (service, key, value) the deployment configures under a name that service cannot hear."""
    dead = []
    for service in compose_services():
        roots = SERVICE_READER_ROOTS.get(service)
        if roots is None:
            raise AssertionError(
                f"compose service `{service}` has no reader roots declared in deploy_plane.py - "
                "a new service must say where its configuration is consumed, or the census would "
                "report it as unread and a later sweep would 'fix' it by deleting the block")
        for key, value in sorted(compose_environment(service).items()):
            if not source_names(key, roots) and not FRAMEWORK_CONVENTION.match(key):
                dead.append((service, key, value))
    return dead

