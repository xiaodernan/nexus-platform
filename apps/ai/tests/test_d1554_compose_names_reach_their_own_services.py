"""D1554 - every name in `infra/docker-compose.yml` must be a name ITS service resolves.

D1550 and D1551 fixed two keys in one block (`ai:`) and left the pattern to this gate: the file is a list
of environment names copied between services, and a name only means something where the service it
belongs to spells it out. The census that produced this unit (`tmp/d1554_census.py` ->
`tmp/d1554_census.txt`) found **56 keys in 10 services**: 28 have a reader in their own tree, 18 are
resolved by a runtime rather than by this repo (`SPRING_*`, `SERVER_PORT`, `POSTGRES_*`, `PGDATA`, `TZ`),
and **10 are configured under names their service cannot hear**.

Two of those ten were the census's own blind spot on its first run: `NEXUS_DB_APP_PASSWORD` and
`NEXUS_DB_AI_PASSWORD` ARE read, by the init SQL that compose:53 bind-mounts into the Postgres image,
which is why `postgres` has a reader-root row at all rather than being waved through as "upstream image"
(R7). The other eight are what this unit fixes:

  * `web:` - four keys naming hops the Next server never resolves, plus a tenant default:
      `PLATFORM_INTERNAL_URL` / `AI_INTERNAL_URL` - no file in `apps/web` spells either name. What the
        server-side BFF resolves is `PLATFORM_API_BASE_URL` / `AI_API_BASE_URL`
        (`apps/web/src/lib/env.ts:36,39`), whose fallbacks are the HOST lane's `127.0.0.1:8090` and
        `:8010`. So in the compose plane the tier calls its own loopback and is refused, while the
        deployment's own comment says it is talking to `http://platform:8080`. This is the one finding
        with a consequence behind it rather than only a discarded value.
      `NEXT_PUBLIC_PLATFORM_URL` / `NEXT_PUBLIC_AI_URL` - unread twice over: no source names them, and a
        `NEXT_PUBLIC_` value is inlined by `next build` from the BUILD environment, so a key sitting in a
        running container's `environment:` cannot reach a browser bundle that was built without it.
      `NEXUS_DEFAULT_TENANT` - `env.ts:47` resolves `NEXUS_TENANT` (then `NEXT_PUBLIC_TENANT`).
  * `platform:` - `NEXUS_DEFAULT_TENANT` again, where `application.yml:78` resolves
      `${NEXUS_TENANT:hong-kong}` for the `nexus.tenant.default-slug` that `TenantFilter.java:23` binds;
      and `NEXUS_CORS_ORIGINS`, which has no reader in `services/platform/src/main` - case-insensitively,
      there is no CORS configuration in that tier at all. CORS belongs to the gateway
      (`services/cloud/gateway/src/main/resources/application.yaml:92`), whose block keeps the name (R6).
  * `admin-server:` - `NEXUS_ADMIN_REGISTER`, sitting next to a yaml comment that says the admin server
      WATCHES and does not register (application.yaml:18-21).

The fixes are therefore two renames that keep the operator's single knob (`NEXUS_TENANT:
${NEXUS_DEFAULT_TENANT:-hong-kong}` in both blocks - the same shape D1551 used for CORS), two renames to
the names the BFF resolves, and three deletions. The same census re-run against the repaired file reads
**52 keys (four lines deleted) and 0 unread outside the runtime-convention set**
(`tmp/d1554_census_after.py` -> `tmp/d1554_census_after.txt`); it calls `unread_compose_keys()` rather than
a copy of it, so a weakened helper and a fixed deployment cannot both be reported as success.

The gate is general on purpose. R1 re-censuses the whole file on every run; R2 refuses to judge a service
whose reader roots nobody declared, so the next block added to this deployment either says where its
configuration is consumed or reddens here instead of silently becoming a hole in the census.
"""
from __future__ import annotations

import re

from deploy_plane import (REPO, SERVICE_READER_ROOTS, compose_environment, compose_services,
                          compose_text_for, unread_compose_keys)

WEB_ENV = REPO / "apps" / "web" / "src" / "lib" / "env.ts"
PLATFORM_YML = REPO / "services" / "platform" / "src" / "main" / "resources" / "application.yml"
GATEWAY_YML = REPO / "services" / "cloud" / "gateway" / "src" / "main" / "resources" / "application.yaml"
INIT_SQL = REPO / "infra" / "postgres" / "init" / "00_roles.sql"
TENANT_KNOB = "NEXUS_DEFAULT_TENANT"          # what `.env` spells, and what apps/ai resolves
DOCKER_DNS = re.compile(r"^http(s)?://[a-z][a-z0-9_-]*:\d+$")


def _shown(env: dict[str, str]) -> str:
    return ", ".join(f"{k}={v!r}" for k, v in sorted(env.items()))


def _env_ts_resolves() -> set[str]:
    """Every name `apps/web` reads out of `process.env`, parsed from the file that reads it."""
    return set(re.findall(r"process\.env\.([A-Z][A-Z0-9_]+)", WEB_ENV.read_text(encoding="utf-8")))


def _spring_placeholder(path, prop: str) -> str:
    """The environment name a Spring `${...}` placeholder on `prop:` resolves."""
    m = re.search(rf"^\s*{prop}:.*?\$\{{([A-Z][A-Z0-9_]+)", path.read_text(encoding="utf-8"), re.M)
    assert m, f"{path.name} has no `${{...}}` placeholder on its `{prop}` line - re-read this unit"
    return m.group(1)


class TestTheWholeFileIsCensused:
    def test_r1_no_block_configures_a_service_under_a_name_it_cannot_hear(self):
        dead = unread_compose_keys()
        assert not dead, (
            "infra/docker-compose.yml configures these services under names their own source never "
            f"reads: {', '.join(f'{svc}:{key}={value!r}' for svc, key, value in dead)} "
            "(reader roots per service: deploy_plane.SERVICE_READER_ROOTS)")

    def test_r2_the_census_judges_the_services_mapping_and_nothing_else(self):
        """`services_region()` is what keeps the census at the blocks that can be configured: the
        children of the top-level `volumes:` mapping are the same shape as a service key and have no
        environment at all, so a parse that walked them would report the deployment as holding blocks no
        one can fix."""
        services = compose_services()
        assert services, "no services parsed at all - the census proves nothing"
        for svc in services:
            block = compose_text_for(svc)
            assert re.search(r"^    (image|build):", block, re.M), (
                f"`{svc}` is counted as a service but its block has neither `image:` nor `build:` - the "
                "parse is reading something that is not a service")
        assert not {"pgdata", "redisdata"} & set(services), (
            "the volume names leaked into the service list; the census would judge them as unread blocks")

    def test_r3_every_service_block_declares_where_its_configuration_is_consumed(self):
        """The loophole this gate refuses to have: an unmapped service cannot be censused, and defaulting
        it to "no roots" would read as dead names for a tier that may simply never have been surveyed."""
        unmapped = [s for s in compose_services() if s not in SERVICE_READER_ROOTS]
        assert not unmapped, (
            f"deploy_plane.SERVICE_READER_ROOTS has no row for {unmapped} - declare where that service "
            "reads its environment, or the whole-file sweep silently stops covering it")



class TestTheWebTierHearsTheHopsItIsGiven:
    def test_r4_the_web_block_carries_only_names_env_ts_resolves(self):
        env = compose_environment("web")
        resolved = _env_ts_resolves()
        unheard = {k: v for k, v in env.items() if k not in resolved}
        assert not unheard, (
            f"the `web:` block configures {_shown(unheard)} and apps/web/src/lib/env.ts resolves only "
            f"{', '.join(sorted(resolved))} out of process.env")

    def test_r5_the_internal_hops_are_container_urls_not_the_build_time_fallbacks(self):
        """The consequence, not the spelling. `env.ts:36,39` fall back to `127.0.0.1:8090` and `:8010`,
        which are the HOST lane's ports; a container that is not given those names therefore calls
        itself, and every same-origin page renders while the BFF's two hops are refused."""
        env = compose_environment("web")
        for key in ("PLATFORM_API_BASE_URL", "AI_API_BASE_URL"):
            assert key in env, (
                f"the `web:` block gives the BFF no {key}, so apps/web falls back to the host lane's "
                f"loopback: {_shown(env)}")
            assert DOCKER_DNS.match(env[key]), (
                f"{key}={env[key]!r} is not a container-network URL (http://<service>:<port>) - the "
                "tier would resolve that name inside its own loopback")
        host_only = {k: v for k, v in env.items() if "localhost" in v or "127.0.0.1" in v}
        assert not host_only, (
            f"the `web:` block points a container at the host's loopback: {_shown(host_only)}")


class TestTheTenantKnobReachesEveryTierThatHasOne:
    def test_r6_the_default_tenant_arrives_under_the_name_each_tier_resolves(self):
        """The operator's knob stays `NEXUS_DEFAULT_TENANT` (that is what `.env` spells and what
        `apps/ai/start_ai.py` resolves); what each OTHER block carries is the name that tier reads."""
        platform_needs = _spring_placeholder(PLATFORM_YML, "default-slug")
        platform = compose_environment("platform")
        assert platform.get(platform_needs), (
            f"services/platform binds `nexus.tenant.default-slug` from ${{{platform_needs}:hong-kong}} "
            f"(application.yml:78) and the `platform:` block does not carry it: {_shown(platform)}")

        web_needs = "NEXUS_TENANT"
        assert web_needs in _env_ts_resolves(), (
            "apps/web no longer resolves NEXUS_TENANT out of process.env - re-measure env.ts:47")
        web = compose_environment("web")
        assert web.get(web_needs), f"the `web:` block does not carry {web_needs}: {_shown(web)}"

        for svc, needs in (("platform", platform_needs), ("web", web_needs)):
            assert TENANT_KNOB not in compose_environment(svc), (
                f"the `{svc}:` block still configures {TENANT_KNOB}, a name that tier never resolves "
                f"(it resolves {needs})")


class TestTheSweepLeftTheNamesThatWork:
    def test_r7_the_gateway_keeps_cors_and_both_tiers_keep_the_internal_token(self):
        """Without this leg the R1 sweep that correctly deletes the platform's unread CORS name is one
        keystroke from deleting the gateway's read one - the tier would stop answering browsers while
        every census stayed green."""
        gateway = compose_environment("gateway")
        cors_name = _spring_placeholder(GATEWAY_YML, "allowedOrigins")
        assert cors_name in gateway, (
            f"the gateway resolves {cors_name} for its CORS allow-list (application.yaml:92) and its "
            f"block no longer carries it: {_shown(gateway)}")
        assert "NEXUS_CORS_ORIGINS" not in compose_environment("platform"), (
            "services/platform has no CORS configuration anywhere in src/main - a name for it in that "
            "block is the defect this unit removed, not a knob to restore")
        for svc in ("ai", "platform"):
            assert compose_environment(svc).get("NEXUS_AI_INTERNAL_TOKEN"), (
                f"the `{svc}:` block must keep the internal token its own door verifies")

    def test_r8_the_postgres_passwords_are_read_by_the_init_sql_the_deployment_mounts(self):
        """The census's own blind spot, pinned. No source in this repo reads `POSTGRES_*` - the image's
        entrypoint does - but these two are read by the SQL that compose:53 mounts at
        `/docker-entrypoint-initdb.d`, and deleting them as unread would bootstrap roles with the wrong
        passwords on a fresh volume."""
        sql = INIT_SQL.read_text(encoding="utf-8")
        read_in_sql = set(re.findall(r"\\getenv\s+\w+\s+([A-Z][A-Z0-9_]*)", sql))
        assert {"NEXUS_DB_APP_PASSWORD", "NEXUS_DB_AI_PASSWORD"} <= read_in_sql, (
            f"00_roles.sql reads {sorted(read_in_sql)} - this leg's premise moved, re-measure it")
        env = compose_environment("postgres")
        for key in sorted(read_in_sql):
            assert key in env, (
                f"the init SQL reads {key} and the postgres block does not carry it: {_shown(env)}")
