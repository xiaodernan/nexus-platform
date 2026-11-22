"""D1550 - the AI container's own CMD must honour the contract the image and the compose file declare.

Three files describe one service and only two of them are read today:

  apps/ai/Dockerfile        `ENV NEXUS_AI_HOST=0.0.0.0`, `NEXUS_AI_PORT=8000`, `EXPOSE 8000`,
                            and `CMD ["python", "start_ai.py"]`.
  infra/docker-compose.yml  publishes `127.0.0.1:${NEXUS_AI_HOST_PORT:-8000}:8000` - the CONTAINER
                            side of that mapping is 8000 - and gives the ai service
                            `NEXUS_DB_URL: postgresql://nexus_ai:...@postgres:5432/nexus`.
  apps/ai/start_ai.py       what the process actually does.

Measured (`tmp/d1550_entrypoint_measure.txt`), by running that real file with a stub `uvicorn` so
nothing serves: inside the container env it binds **127.0.0.1:8010**. Two independent causes, both
invisible to any unit test of application logic:

  * `host='127.0.0.1'` is hardcoded, although the image declares `NEXUS_AI_HOST=0.0.0.0`. A
    container's loopback is reachable from that container alone, so a published port has nothing
    behind it and a peer hop to `http://ai:8000` is refused.
  * the port comes from `NEXUS_AI_HOST_PORT`, which is the HOST side of the published mapping and is
    not in the container's environment - but `start_ai.py` seeds it with `setdefault(..., '8010')`,
    so the process answers 8010 while 8000 is what is published and what EXPOSE promises.
  * the same file resolves the database from `NEXUS_DATABASE_URL` only. Compose names it
    `NEXUS_DB_URL`, which the app reads nowhere, so the container falls back to a hardcoded
    `127.0.0.1:5433` - a Postgres that does not exist in that network namespace - and serves the
    labelled demo catalogue while an operator believes the live tier is running.

The expectations below are PARSED from the Dockerfile and the compose file rather than typed here, so
the door moves with the deployment instead of drifting from it. R3 is the host lane's boundary: the
cloud smoke scripts launch this same file with `NEXUS_AI_HOST_PORT` set, and that behaviour must not
move either.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from pathlib import Path

AI_DIR = Path(__file__).resolve().parents[1]
REPO = AI_DIR.parents[1]
DOCKERFILE = AI_DIR / "Dockerfile"
COMPOSE = REPO / "infra" / "docker-compose.yml"

STUB_UVICORN = """
import json, os

def run(app, host=None, port=None, **kw):
    print("BIND " + json.dumps({"host": host, "port": port}))
    print("HOSTPORT " + os.environ.get("NEXUS_AI_HOST_PORT", "<unset>"))
"""


def _dockerfile_env() -> dict[str, str]:
    txt = DOCKERFILE.read_text(encoding="utf-8")
    out = {}
    for m in re.finditer(r"^\s*(NEXUS_AI_HOST|NEXUS_AI_PORT)=([^\s\\]+)", txt, re.M):
        out[m.group(1)] = m.group(2)
    return out


def _compose_text_for(service: str) -> str:
    lines = COMPOSE.read_text(encoding="utf-8").splitlines()
    start = None
    for i, raw in enumerate(lines):
        m = re.match(r"^  ([a-z0-9_-]+):$", raw)
        if m and m.group(1) == service:
            start = i
        elif start is not None and i > start and re.match(r"^  [a-z0-9_-]+:$", raw):
            return "\n".join(lines[start:i])
    return "\n".join(lines[start:]) if start is not None else ""


def _compose_environment(service: str) -> dict[str, str]:
    block = _compose_text_for(service)
    out, in_env = {}, False
    for raw in block.splitlines():
        if re.match(r"^    environment:\s*$", raw):
            in_env = True
            continue
        if in_env:
            k = re.match(r"^      ([A-Z][A-Z0-9_]*):\s*(.*?)\s*(?:#.*)?$", raw)
            if k:
                out[k.group(1)] = re.sub(r"\$\{[A-Z0-9_]+:-([^}]*)\}", r"\1", k.group(2)).strip('"')
            elif raw.strip() and not raw.startswith("      "):
                in_env = False
    return out


def _published_container_port(service: str) -> str:
    # - "127.0.0.1:${NEXUS_AI_HOST_PORT:-8000}:8000"  -> the CONTAINER side is what must be bound.
    m = re.search(r'-\s*"127\.0\.0\.1:.+?:(\d+)"', _compose_text_for(service))
    assert m, f"no published port mapping found for service {service}"
    return m.group(1)


def _container_env(extra: dict[str, str] | None = None) -> dict[str, str]:
    """The environment a container of this image actually gets: image ENV + the compose block."""
    base = {k: v for k, v in os.environ.items() if not k.upper().startswith("NEXUS_")}
    base.update(_dockerfile_env())
    base.update(_compose_environment("ai"))
    base.pop("NEXUS_AI_HOST_PORT", None)          # the HOST side never reaches the container
    base.update(extra or {})
    return base


def _decide(env: dict[str, str], tmp_path: Path) -> dict:
    stub = tmp_path / "stub"
    stub.mkdir(exist_ok=True)
    (stub / "uvicorn.py").write_text(STUB_UVICORN, encoding="utf-8")
    run_env = dict(env)
    run_env["PYTHONPATH"] = str(stub)             # captured before site-packages, so run() is ours
    r = subprocess.run([sys.executable, str(AI_DIR / "start_ai.py")], env=run_env, cwd=str(AI_DIR),
                       capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=180)
    out = (r.stdout or "") + (r.stderr or "")
    bind = re.search(r"^BIND (\{.*\})", out, re.M)
    assert bind, f"the entrypoint did not reach uvicorn.run: {out[-300:]}"
    got = json.loads(bind.group(1))
    got["host_port_env"] = (re.search(r"^HOSTPORT (\S+)", out, re.M) or [None, "<unset>"])[1]
    return got


class TestContainerEntryHonoursTheImageContract:
    def test_r1_binds_the_interface_the_image_declares_not_container_loopback(self, tmp_path):
        declared = _dockerfile_env()
        assert declared.get("NEXUS_AI_HOST"), "the Dockerfile no longer declares NEXUS_AI_HOST - re-read this unit"
        got = _decide(_container_env(), tmp_path)["host"]
        assert got == declared["NEXUS_AI_HOST"], (
            f"the image declares {declared['NEXUS_AI_HOST']} but the CMD binds {got}: peers and the "
            "published mapping cannot reach a container's loopback")

    def test_r2_binds_the_port_the_compose_plane_publishes_to(self, tmp_path):
        published = _published_container_port("ai")
        got = _decide(_container_env(), tmp_path)["port"]
        assert str(got) == published, (
            f"compose publishes container port {published} but the CMD listens on {got}")

    def test_r3_the_host_lane_keeps_binding_its_own_host_port_knob(self, tmp_path):
        """Boundary leg: scripts/cloud_lb_smoke.sh and cloud_ai_admin_smoke.sh launch this file with
        NEXUS_AI_HOST_PORT only. Repairing the container must not move the plane that works."""
        got = _decide({"PATH": os.environ.get("PATH", ""), "SystemRoot": os.environ.get("SystemRoot", ""),
                       "PYTHONPATH": "", "NEXUS_AI_HOST_PORT": "8010"}, tmp_path)
        assert (got["host"], str(got["port"])) == ("127.0.0.1", "8010"), (
            f"the host lane moved to {got} - it must stay on loopback:8010 unless the image says otherwise")

    def test_r4_the_database_the_deployment_names_is_the_one_the_app_resolves(self, monkeypatch):
        env = _compose_environment("ai")
        db_key = next((k for k in env if k.endswith("_URL") and re.search(r"DB|DATABASE", k)), None)
        assert db_key, "the compose ai block sets no DB URL at all - re-read this unit"
        for name in ("NEXUS_DATABASE_URL", "DATABASE_URL", "NEXUS_AI_DB_URL", "NEXUS_DB_URL"):
            monkeypatch.delenv(name, raising=False)
        monkeypatch.setenv(db_key, env[db_key])
        assert db_key == "NEXUS_DATABASE_URL", (
            f"the deployment names the AI's database {db_key}, which apps/ai reads nowhere "
            f"(config resolves NEXUS_DATABASE_URL / DATABASE_URL / NEXUS_AI_DB_URL)")
        from nexus_ai.config import load_settings, reset_settings_cache

        reset_settings_cache()
        try:
            url = load_settings().database_url
        finally:
            reset_settings_cache()
        assert "postgres:5432" in url, (
            f"the app resolved {url!r} - not the service Postgres the deployment handed it")


class TestTheEntrypointLeavesNoDriftedPort:
    def test_r5_it_does_not_invent_the_host_side_variable_inside_the_container(self, tmp_path):
        """`setdefault('NEXUS_AI_HOST_PORT', '8010')` is what makes the wrong port look intentional:
        discovery.py registers NEXUS_AI_HOST_PORT first, so seeding it inside the container tells
        Eureka about a port nothing published."""
        got = _decide(_container_env(), tmp_path)
        assert got["host_port_env"] == "<unset>", (
            f"nothing in the deployment set NEXUS_AI_HOST_PORT for this process, yet it reports "
            f"{got['host_port_env']}: the entrypoint invents the HOST side of the mapping inside the "
            f"container, and discovery.py registers that value while the CMD binds {got['port']}")
