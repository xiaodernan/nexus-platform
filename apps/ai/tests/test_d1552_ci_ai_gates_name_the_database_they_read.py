"""D1552 - CI's AI gates keep their declared environment and live-test database boundary."""
from __future__ import annotations

import shlex
from collections import Counter
from urllib.parse import urlsplit

from deploy_plane import ci_workflow

APP_DATABASE_KEYS = {"NEXUS_DATABASE_URL", "DATABASE_URL", "NEXUS_AI_DB_URL"}
LIVE_DATABASE_KEY = "NEXUS_TEST_DATABASE_URL"
DEAD_DATABASE_KEY = "NEXUS_DB_URL"
TEST_GATE_KEYS = {LIVE_DATABASE_KEY, "NEXUS_REDIS_URL", "NEXUS_LLM_PROVIDER"}
EVAL_GATE_KEYS = {LIVE_DATABASE_KEY, "NEXUS_LLM_PROVIDER"}


def _ai_gate_steps() -> list[dict]:
    steps = ci_workflow()["jobs"]["ai"]["steps"]
    tests = [step for step in steps if step.get("run") == "uv run pytest -q"]
    evaluations = [step for step in steps if "nexus_ai.eval.cli" in step.get("run", "")]
    assert len(tests) == 1, "the AI job must keep one unit-test gate"
    assert len(evaluations) == 1, "the AI job must keep one evaluation gate"
    assert all(step.get("working-directory") == "apps/ai" for step in tests + evaluations)
    return tests + evaluations


def _environment(step: dict) -> dict[str, str]:
    return {str(key): str(value) for key, value in step.get("env", {}).items()}


def _ai_inherited_environments() -> list[dict[str, str]]:
    workflow = ci_workflow()
    return [_environment(workflow), _environment(workflow["jobs"]["ai"])]


def _database_names(environments: list[dict[str, str]]) -> set[str]:
    names = set().union(*(set(env) for env in environments))
    return names & (APP_DATABASE_KEYS | {DEAD_DATABASE_KEY})


class TestCiAiGatesNameOnlyWhatTheirLaneReads:
    def test_r1_both_gates_keep_the_live_test_database_under_its_real_name(self):
        tests, evaluation = _ai_gate_steps()
        test_env, eval_env = _environment(tests), _environment(evaluation)

        assert test_env.get(LIVE_DATABASE_KEY), "the unit gate lost its live-database legs"
        assert eval_env.get(LIVE_DATABASE_KEY), "the evaluation gate lost its documented test-database knob"
        assert test_env[LIVE_DATABASE_KEY] == eval_env[LIVE_DATABASE_KEY], (
            "the two AI gates now point at different test databases")
        for value in (test_env[LIVE_DATABASE_KEY], eval_env[LIVE_DATABASE_KEY]):
            url = urlsplit(value)
            assert (url.scheme, url.username, url.hostname, url.port, url.path) == (
                "postgresql", "nexus_ai", "127.0.0.1", 5433, "/nexus_test"), (
                f"the live gate must use the restricted nexus_ai role against nexus_test, not {value!r}")

    def test_r2_the_gate_environments_keep_only_their_declared_ai_keys(self):
        tests, evaluation = _ai_gate_steps()
        test_env, eval_env = _environment(tests), _environment(evaluation)

        assert set(test_env) == TEST_GATE_KEYS, (
            f"the unit gate's environment drifted to {sorted(test_env)}; update this pin deliberately")
        assert set(eval_env) == EVAL_GATE_KEYS, (
            f"the evaluation gate's environment drifted to {sorted(eval_env)}; update this pin deliberately")
        assert not _database_names(_ai_inherited_environments()), (
            "a workflow- or AI-job-level database alias would leak into both Python gates through inheritance")

    def test_r3_the_gates_do_not_advertise_an_app_pool_and_the_eval_cli_opens_none(
            self, monkeypatch, capsys):
        for step in _ai_gate_steps():
            assert not APP_DATABASE_KEYS.intersection(_environment(step)), (
                f"{step.get('name')} advertises an application pool; the unit fixture clears "
                "NEXUS_DATABASE_URL and DATABASE_URL, and the evaluation CLI opens no app pool")
        evaluation = _ai_gate_steps()[1]
        from nexus_ai.db import pool

        def forbidden_connect(*args, **kwargs):
            raise AssertionError("the evaluation gate tried to open an application database pool")

        monkeypatch.setattr(pool, "connect", forbidden_connect)
        from nexus_ai.eval import cli

        argv = shlex.split(evaluation["run"])[5:]
        assert cli.main(argv) == 0
        report = capsys.readouterr().out
        assert "RESULT: PASS - 5 suite(s), 0 failing" in report

    def test_r4_the_platform_database_name_stays_on_the_platform_steps(self):
        workflow = ci_workflow()
        owners = []
        if DEAD_DATABASE_KEY in _environment(workflow):
            owners.append(("workflow", {}))
        for job, definition in workflow["jobs"].items():
            if DEAD_DATABASE_KEY in _environment(definition):
                owners.append((job, definition))
            owners.extend(
                (job, step)
                for step in definition.get("steps", [])
                if DEAD_DATABASE_KEY in _environment(step)
            )
        assert len(owners) == 3, (
            f"the platform's three NEXUS_DB_URL consumers changed to {len(owners)}; re-read the workflow")
        assert Counter(job for job, _ in owners) == {"platform": 1, "cloud": 2}, (
            "the JDBC consumers must stay on the platform unit job and the cloud monolith smokes")
        assert all(job != "ai" for job, _ in owners), "the platform's database name leaked into the AI job"
        assert all(_environment(step)[DEAD_DATABASE_KEY].startswith("jdbc:") for _, step in owners), (
            "the platform's NEXUS_DB_URL is a JDBC URL; an AI DSN here means the wrong service owns it")
