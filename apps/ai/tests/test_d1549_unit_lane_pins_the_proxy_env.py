"""D1549 - the AI unit lane's verdict is decided by the code, not by the machine it runs on.

§1451 closed the product half of this host's proxy environment and recorded the residue: 4 red in
`tests/test_request_timeout_reaches_the_adapters.py`. Every one of them builds a LIVE LLM adapter,
whose httpx client reads the ambient proxy environment BY DESIGN - the product is right, and D1548
deliberately left it that way. The lane is wrong: a test of a timeout knob fails on a machine with no
network fault, because the developer's shell exports `NO_PROXY=[::1]`, which httpx 0.28.1 cannot
parse. `tests/conftest.py`'s `offline_env` docstring already promises that "the real environment"
cannot make a unit test depend on infrastructure; the proxy variables are the leak it never closed.

`tmp/d1549_measure.txt` isolates it: one pytest invocation, the same bytes, two environments -
`18 passed` with the proxy variables removed, `4 failed, 14 passed` with this host's values restored.

So this door cannot be an in-process claim about this machine: on a clean CI box the shipped code is
already green and a leg that only reddens here would certify nothing. The door supplies the poison
itself. R1 runs the real lane file in a subprocess under a hostile environment and compares it with
the same file run clean. R2 shows the mechanism at the lane boundary. R4 is the user-visible shape
from the file R1 protects, in-process. R3 is the boundary the fix must not cross: a proxy a test
configures on purpose must still reach the external hop, or hermeticity has become deafness.

Offline throughout: no socket is opened by this file's own legs, and the subprocess runs the lane's
own offline tests.
"""
from __future__ import annotations

import asyncio
import os
import re
import subprocess
import sys
from pathlib import Path

import httpx
import pytest

from nexus_ai.models.base import HttpLLMAdapter

AI_DIR = Path(__file__).resolve().parents[1]
LANE_FILE = "tests/test_request_timeout_reaches_the_adapters.py"
PROXY_NAMES = ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY")

# What this host exports (tmp/d1546_base_env_probe.txt), with the unreachable relay D1548 uses.
HOSTILE = {
    "HTTP_PROXY": "http://proxy.invalid:3128",
    "HTTPS_PROXY": "http://proxy.invalid:3128",
    "NO_PROXY": "localhost,.localhost,127.0.0.1,127.0.0.0/8,[::1],::1",
}


def _pool_for(client: httpx.AsyncClient, url: str) -> str:
    """AsyncConnectionPool = direct, AsyncHTTPProxy = proxied (the transport class cannot tell them)."""
    return type(client._transport_for_url(httpx.URL(url))._pool).__name__


def _lane_run(extra):
    """Run the real lane file as its own pytest process, with the environment this leg means."""
    env = {k: v for k, v in os.environ.items() if k.upper() not in PROXY_NAMES}
    env.update(extra)
    r = subprocess.run([sys.executable, "-m", "pytest", "-q", "-p", "no:cacheprovider", LANE_FILE],
                       cwd=str(AI_DIR), env=env, capture_output=True, text=True, timeout=600)
    out = (r.stdout or "") + (r.stderr or "")
    return next((l for l in out.strip().splitlines()
                 if " passed" in l or "failed" in l or "error" in l), out[-200:])


def _counts(summary: str):
    def one(name):
        m = re.search(r"(\d+) " + name, summary)
        return int(m.group(1)) if m else 0
    return one("failed"), one("passed"), ("error" in summary.lower())


@pytest.fixture(autouse=True, scope="module")
def poison_lane_env():
    """Put the host's shape into the process BEFORE the lane's own fixtures run.

    Module scope, so the variables are there for every test in this file and `offline_env` is the
    only thing that can take them away - which is exactly what R2 measures. Restored on teardown.
    """
    saved = {k: os.environ.get(k) for k in HOSTILE}
    os.environ.update(HOSTILE)
    yield
    for k, v in saved.items():
        if v is None:
            os.environ.pop(k, None)
        else:
            os.environ[k] = v


class TestUnitLanePinsTheProxyEnv:
    def test_r1_the_lane_file_gives_one_verdict_whatever_it_inherits(self):
        clean = _counts(_lane_run({}))
        hostile = _counts(_lane_run(HOSTILE))
        assert not clean[2] and not hostile[2], f"a run failed to collect: clean={clean} hostile={hostile}"
        assert clean[1] > 0, "the clean run collected nothing, so parity would prove nothing"
        assert hostile[0] == 0, f"the lane is red under a proxy environment: {hostile}"
        assert hostile == clean, f"the same bytes gave {clean} clean and {hostile} hostile: the host decides"

    def test_r2_no_proxy_variable_survives_into_a_test_body(self):
        left = sorted(k for k in os.environ if k.upper() in PROXY_NAMES)
        assert left == [], f"the autouse fixture let these reach the test: {left}"

    def test_r3_a_proxy_a_test_sets_on_purpose_still_routes_the_live_hop(self, monkeypatch):
        """Hermetic is not deaf: clearing the lane's environment must not remove the operator's knob."""
        monkeypatch.setenv("HTTPS_PROXY", "http://proxy.invalid:3128")
        monkeypatch.setenv("NO_PROXY", "localhost,127.0.0.1")
        adapter = HttpLLMAdapter(base_url="https://api.test/v1", api_key="k")
        try:
            assert _pool_for(adapter._http(), "https://api.test/v1/chat/completions") == "AsyncHTTPProxy"
        finally:
            asyncio.run(adapter._http().aclose())

    def test_r4_the_timeout_knob_test_needs_no_neutralised_shell(self):
        """The D983 shape, in-process: build a live adapter while the module poison is in force."""
        adapter = HttpLLMAdapter(base_url="https://api.test/v1", api_key="k", timeout_s=37.0)
        try:
            client = adapter._http()          # shipped: InvalidURL from the inherited NO_PROXY
            assert float(client.timeout.read) == 37.0
        finally:
            asyncio.run(adapter._http().aclose())
