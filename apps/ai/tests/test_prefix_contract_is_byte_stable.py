"""D1050 — the shared prefix contract is frozen, long enough to cache, and shared.

Why these assertions exist: the previous low cache hit-rate was not a provider problem and
not a transport problem. It was that every call's *stable head* was either 17 tokens (the
adapter default, for summary) or ~440 tokens (the intent schema, still under the provider's
~1024-token cacheable floor). A prefix shorter than the floor is never served from cache, so
diverse traffic measured 0% no matter what the transport looked like.

The invariants pinned here are the ones that make the upstream cache reachable at all:

1. the preamble clears the cacheable floor, with margin;
2. it is byte-identical call to call AND process to process (no clock, no env, no locale);
3. it is the *prefix* of every task contract, so one model serves one shared cache entry;
4. the pre-D1050 behaviour is exactly recoverable with ``NEXUS_PREFIX_CONTRACT=off``;
5. the tuned intent schema survives verbatim as the tail — this unit must not change what
   the model is asked to extract, only what it can reuse.
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

import pytest

from nexus_ai.models.prefix_contract import (
    MIN_CACHEABLE_CHARS,
    PREFIX_CONTRACT_SHA256,
    PREFIX_CONTRACT_VERSION,
    contract_for,
    contract_stats,
)

AI_ROOT = Path(__file__).resolve().parents[1]


def test_the_preamble_clears_the_providers_cacheable_floor_with_margin():
    stats = contract_stats()
    assert stats["clears_cacheable_floor"] is True
    # A bare pass is not enough: tokenisers vary, and the floor is ~1024 tokens. Demand
    # 1.5x the local floor so an unusually tight tokeniser still clears the provider's.
    assert stats["chars"] >= int(MIN_CACHEABLE_CHARS * 1.5), stats
    assert stats["approx_tokens"] >= 1_200, stats


def test_the_preamble_is_byte_identical_on_every_call_and_under_every_env():
    first = contract_for("summary")
    for _ in range(50):
        assert contract_for("summary") == first

    # Environment must not leak into the frozen head: the probe and CI run under different
    # locales and paths, and a different head means a cold cache for that process.
    baseline = contract_for("summary")
    for key, value in [
        ("TZ", "UTC"), ("LANG", "en_US.UTF-8"), ("LC_ALL", "C"),
        ("NEXUS_LLM_MODEL_MID", "some-other-model"), ("NEXUS_PREFIX_CONTRACT", ""),
    ]:
        old = os.environ.get(key)
        os.environ[key] = value
        try:
            assert contract_for("summary") == baseline, f"{key} leaked into the prefix"
        finally:
            if old is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = old


def test_the_preamble_is_byte_identical_across_processes():
    """A fresh interpreter must produce the same bytes — catches set/dict-order leakage."""
    code = (
        "import sys; sys.path.insert(0, %r);"
        "from nexus_ai.models.prefix_contract import contract_for, PREFIX_CONTRACT_SHA256;"
        "print(PREFIX_CONTRACT_SHA256);"
        "sys.stdout.write(contract_for('summary'))" % str(AI_ROOT)
    )
    runs = [subprocess.run([sys.executable, "-c", code], capture_output=True, text=True,
                           cwd=str(AI_ROOT), check=True).stdout for _ in range(3)]
    assert runs[0] == runs[1] == runs[2]
    assert runs[0].splitlines()[0] == PREFIX_CONTRACT_SHA256
    assert runs[0].split("\n", 1)[1] == contract_for("summary")


def test_every_task_contract_starts_with_the_one_shared_preamble():
    stats = contract_stats()
    preamble = contract_for("intent_extract")  # no task tail -> the preamble alone
    assert len(preamble) == stats["chars"]
    for task in ["summary", "generate_ui_copy"]:
        full = contract_for(task)
        assert full.startswith(preamble), f"{task} does not share the cacheable head"
        assert len(full) > len(preamble), f"{task} has no task tail"


def test_the_contract_can_be_switched_off_and_restores_the_pre_d1050_prompt(
        monkeypatch):
    monkeypatch.setenv("NEXUS_PREFIX_CONTRACT", "off")
    assert contract_for("summary") == ""  # pre-D1050: no system at all for summary
    assert contract_for("intent_extract", "SCHEMA") == "SCHEMA"  # exactly the old body
    assert contract_stats()["enabled"] is False

    for off in ("0", "false", "no", "OFF", " off "):
        monkeypatch.setenv("NEXUS_PREFIX_CONTRACT", off)
        assert contract_for("summary") == "", off

    monkeypatch.setenv("NEXUS_PREFIX_CONTRACT", "on")
    assert contract_for("summary").startswith("NEXUS PLATFORM CONTRACT")


def test_the_tuned_intent_schema_is_preserved_verbatim_as_the_tail():
    from nexus_ai.api.pipeline import INTENT_EXTRACT_SYSTEM, _INTENT_SCHEMA_BODY

    assert INTENT_EXTRACT_SYSTEM == contract_for("intent_extract", _INTENT_SCHEMA_BODY)
    assert INTENT_EXTRACT_SYSTEM.endswith(_INTENT_SCHEMA_BODY)
    # The schema the model is graded on must not have been rewritten by this unit.
    assert "API_CONTRACT §7.1" in _INTENT_SCHEMA_BODY
    assert _INTENT_SCHEMA_BODY.rstrip().endswith("Answer with JSON only.")


def test_the_version_and_sha_travel_with_the_prefix():
    assert PREFIX_CONTRACT_VERSION == "v1"
    assert len(PREFIX_CONTRACT_SHA256) == 16
    assert PREFIX_CONTRACT_SHA256 == contract_stats()["sha256"]
    # The contract announces its own version, so a stale cached head is distinguishable
    # from a fresh one in provider logs.
    assert PREFIX_CONTRACT_VERSION in contract_for("summary")[:64]


@pytest.mark.parametrize("task", ["summary", "intent_extract", "generate_ui_copy"])
def test_no_volatile_token_survives_in_the_frozen_head(task):
    head = contract_for(task)
    lowered = head.lower()
    for banned in ("{", "}", "%s", "datetime.now", "time.time", "uuid4"):
        assert banned not in lowered, f"{banned!r} in the frozen head of {task}"
