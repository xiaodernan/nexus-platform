"""D1571 - the full profile builds the three images it declares and mounts only files a service reads."""
from __future__ import annotations

import re
from pathlib import Path

from deploy_plane import REPO, compose_environment, compose_text_for

COMPOSE = REPO / "infra" / "docker-compose.yml"
PLATFORM_DOCKERFILE = REPO / "services" / "platform" / "Dockerfile"
WEB_DOCKERFILE = REPO / "apps" / "web" / "Dockerfile"
AI_DOCKERFILE = REPO / "apps" / "ai" / "Dockerfile"


def _build(service: str) -> tuple[Path, str]:
    block = compose_text_for(service)
    context = re.search(r"^      context:\s*(\S+)", block, re.M)
    dockerfile = re.search(r"^      dockerfile:\s*(\S+)", block, re.M)
    assert context and dockerfile, f"`{service}:` has no complete build declaration"
    return (COMPOSE.parent / context.group(1)).resolve(), dockerfile.group(1)


def _dockerfile(service: str) -> tuple[Path, str]:
    context, name = _build(service)
    path = context / name
    assert path.is_file(), f"`{service}:` builds {path.relative_to(REPO)}, which does not exist"
    return path, path.read_text(encoding="utf-8")


class TestTheFullProfileHasBuildableRecipes:
    def test_r1_every_full_profile_app_points_at_a_dockerfile_inside_its_context(self):
        services = compose_text_for("platform") + compose_text_for("ai") + compose_text_for("web")
        assert services.count('profiles: ["full"]') == 3, "the full-profile premise moved; re-read compose"
        for service in ("platform", "ai", "web"):
            context, name = _build(service)
            assert (context / name).is_file(), (
                f"`{service}:` context {context.relative_to(REPO)} has no {name}; --profile full cannot build")

    def test_r2_platform_packages_the_jar_and_the_migrations_its_pom_copies(self):
        path, text = _dockerfile("platform")
        assert path == PLATFORM_DOCKERFILE, "the platform recipe moved; re-read the build declaration"
        pom = (REPO / "services" / "platform" / "pom.xml").read_text(encoding="utf-8")
        final_name = re.search(r"<finalName>([^<]+)</finalName>", pom)
        assert final_name, "services/platform/pom.xml no longer names its packaged jar"
        assert "COPY infra/db/migrations infra/db/migrations" in text, (
            "the Maven resource plugin copies ../../infra/db/migrations; the root build context must carry it")
        assert f"/src/services/platform/target/{final_name.group(1)}.jar" in text, (
            "the runtime stage copies a jar name the platform pom does not produce")
        assert 'ENTRYPOINT ["java", "-jar", "/app/app.jar"]' in text, (
            "the platform image does not launch the packaged Spring Boot jar")

    def test_r3_web_builds_the_workspace_and_inlines_live_mode_at_build_time(self):
        path, text = _dockerfile("web")
        assert path == WEB_DOCKERFILE, "the web recipe moved; re-read the build declaration"
        for required in ("COPY package.json package-lock.json ./", "COPY packages packages",
                         "COPY docs/evidence docs/evidence", "RUN npm ci",
                         "RUN npm run build --workspace @nexus/web",
                         'CMD ["npm", "run", "start", "--workspace", "@nexus/web"]'):
            assert required in text, f"apps/web/Dockerfile is missing {required!r}"
        assert re.search(r"^ARG NEXT_PUBLIC_DATA_MODE=live$", text, re.M), (
            "the web bundle must default to live mode; a runtime environment cannot change an inlined constant")
        block = compose_text_for("web")
        assert re.search(r"^\s+NEXT_PUBLIC_DATA_MODE:\s*\$\{NEXUS_WEB_DATA_MODE:-live\}", block, re.M), (
            "the web build does not expose the operator's data-mode knob")
        assert "NEXT_PUBLIC_DATA_MODE" not in compose_environment("web"), (
            "NEXT_PUBLIC_DATA_MODE was put in runtime environment, where next build cannot read it")

    def test_r4_the_ai_keeps_no_migration_mount_it_cannot_read(self):
        assert not re.search(r"^\s+- .*:/migrations(?::ro)?\s*(?:#.*)?$", compose_text_for("ai"), re.M), (
            "the ai block mounts /migrations, but no AI reader names that path")
        assert "./db/migrations:/migrations:ro" in compose_text_for("postgres"), (
            "the postgres migration mount is used by make db-migrate and must not be removed with the AI's")

    def test_r5_the_runbook_no_longer_calls_the_shipped_recipes_missing(self):
        documents = (REPO / "docs" / "DEPLOYMENT.md", REPO / "docs" / "ENVIRONMENT_REPORT.md",
                     REPO / "Makefile")
        stale = ("have no Dockerfile yet", "needs the missing Dockerfiles", "Dockerfiles do not\n  exist yet",
                 "no Dockerfiles yet", "Those three files do NOT exist")
        for path in documents:
            text = path.read_text(encoding="utf-8")
            for phrase in stale:
                assert phrase not in text, f"{path.relative_to(REPO)} still says {phrase!r}"
        deployment = documents[0].read_text(encoding="utf-8")
        assert "services/platform/Dockerfile" in deployment and "apps/web/Dockerfile" in deployment, (
            "DEPLOYMENT.md no longer names the two shipped build recipes")


class TestTheBuildContextExcludesLocalState:
    def test_r6_root_context_cannot_bake_shell_secrets_or_host_build_output(self):
        path = REPO / ".dockerignore"
        assert path.is_file(), "platform and web build from the repo root and need a root .dockerignore"
        lines = set(path.read_text(encoding="utf-8").splitlines())
        assert {"**/.env", "**/.env.*", "**/node_modules", "**/.next", "**/target",
                "**/dist", "**/dist-test"} <= lines, (
            "the root build context can bake local env files, dependencies or stale build output")
