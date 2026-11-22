"""D1551 - every name the deployment uses to configure the AI must be a name the AI reads.

D1550 fixed one key in `infra/docker-compose.yml`'s `ai:` block and left the block's honesty to a
census, because the pattern is what matters: a block of 14 environment names, copied from the
platform's own block, of which three had no reader in `apps/ai` at all
(`tmp/d1550_ai_key_census.txt`):

  * `NEXUS_CORS_ORIGINS` - the platform's spelling (its sibling in the `platform:` block, and
    `services/cloud/gateway/src/main/resources/application.yaml` reads it too). The AI resolves
    `NEXUS_AI_CORS_ORIGINS` (`nexus_ai/config.py:125`), so in the compose plane `cors_origins` is an
    EMPTY tuple and `nexus_ai/api/app.py:111` installs the CORS middleware only
    `if deps.settings.cors_origins:` - the deployment says "allow http://localhost:3000" and the
    service answers no browser origin whatsoever. Nothing fails loudly: same-origin server calls
    work, so the tier looks healthy until a browser is involved.
  * `NEXUS_JWT_SECRET` - `git grep -l jwt apps/ai` returns nothing. The AI authenticates its internal
    callers with `NEXUS_AI_INTERNAL_TOKEN`; an operator rotating the JWT secret in the AI's block
    changes the platform and the gateway, never the AI, and would believe otherwise.
  * `NEXUS_DB_SCHEMA_SCRIPTS` - no spelling of it exists anywhere in `apps/ai`. The `/migrations`
    volume mount (compose:156) does put SQL into the container, and measured the same way nothing in
    `apps/ai` names `/migrations` either - that half is re-measured with the rest of the plane in D1554.

R1 and R2 are the contract (parsed from the compose file via `tests/deploy_plane.py`, so the gate
moves with the deployment and reddens on the next copy-paste). R3 is the consequence, watched through
the real ASGI app rather than asserted about. R4 is the boundary: the AI's own auth knob must stay in
that block, so a future sweep that "removes unread secrets" cannot leave the tier unauthenticated.
"""
from __future__ import annotations

from fastapi.testclient import TestClient

from deploy_plane import AI_READER_ROOTS, compose_environment, unread_ai_keys
from nexus_ai.api.app import create_app
from nexus_ai.config import Settings, load_settings, reset_settings_cache
from nexus_ai.models import factory

DEPLOY_ORIGIN = "http://localhost:3000"
CONFIG_RESOLVES = "NEXUS_AI_CORS_ORIGINS"


def _settings_with(**kw) -> Settings:
    base = dict(llm_provider="mock", embedding_provider="hashing", database_url="",
                internal_token="", demo_data=True)
    return Settings(**{**base, **kw})


def _acao_header(cors_origins: tuple[str, ...]) -> str | None:
    """What the deployed app actually answers a browser preflight with."""
    with TestClient(create_app(_settings_with(cors_origins=cors_origins))) as c:
        r = c.options("/ai/v1/health", headers={"Origin": DEPLOY_ORIGIN,
                                                "Access-Control-Request-Method": "GET"})
    return r.headers.get("access-control-allow-origin")


class TestTheAiBlockNamesWhatTheAiReads:
    def test_r1_the_cors_origins_the_deployment_sets_reach_the_settings(self, monkeypatch):
        env = compose_environment("ai")
        key = next((k for k in env if "CORS" in k), None)
        assert key, "the ai block no longer configures CORS at all - re-read this unit"
        assert key == CONFIG_RESOLVES, (
            f"the deployment configures the AI's CORS allow-list as {key}, but "
            f"nexus_ai/config.py:125 resolves {CONFIG_RESOLVES}")
        for name in ("NEXUS_CORS_ORIGINS", CONFIG_RESOLVES):
            monkeypatch.delenv(name, raising=False)
        monkeypatch.setenv(key, env[key])
        reset_settings_cache()
        factory.reset_provider_cache()
        try:
            origins = load_settings().cors_origins
        finally:
            reset_settings_cache()
        assert origins == tuple(o.strip() for o in env[key].split(",") if o.strip()), (
            f"the block says {env[key]!r} and the service resolved {origins}")
        assert origins, "the deployment's CORS value has to survive the comma split"

    def test_r2_no_key_in_the_ai_block_is_a_name_the_ai_cannot_hear(self):
        dead = unread_ai_keys()
        assert not dead, (
            "infra/docker-compose.yml's ai: block configures the AI under names apps/ai never reads: "
            f"{', '.join(f'{k}={v!r}' for k, v in dead)} "
            f"(reader roots searched: {', '.join(AI_READER_ROOTS)})")


class TestTheConsequenceIsTheServicesOwn:
    def test_r3_an_unconfigured_allow_list_answers_no_browser_origin(self):
        """The mechanism R1 guards, watched through the real app: `app.py:111` installs
        CORSMiddleware only when the list is non-empty, so an unread key is not a warning - it is a
        tier that refuses every cross-origin call while every same-origin call succeeds."""
        assert _acao_header(()) is None, (
            "the app now answers a preflight with an allow-origin even with an EMPTY configured list; "
            "if that is intended, R1's premise (a dropped CORS value is silent) must be re-measured")
        assert _acao_header((DEPLOY_ORIGIN,)) == DEPLOY_ORIGIN, (
            "and with the value the deployment means, the header must come back - otherwise this leg "
            "is not watching the thing it claims to watch")

    def test_r4_the_ais_own_internal_auth_knob_stays_in_the_block(self):
        env = compose_environment("ai")
        assert env.get("NEXUS_AI_INTERNAL_TOKEN"), (
            "the AI's internal token is the one secret its callers present and its door verifies; "
            "removing unread names must never remove this one")
        dead = {k for k, _ in unread_ai_keys()}
        assert "NEXUS_AI_INTERNAL_TOKEN" not in dead
