"""D1572 - production npm installs carry the patched Next dependency closure."""
from __future__ import annotations

import json

from deploy_plane import REPO

SAFE_MINIMUMS = {
    "next": (15, 5, 29),
    "postcss": (8, 5, 33),
    "sharp": (0, 35, 5),
    "source-map-js": (1, 2, 4),
}


def _json(relative: str) -> dict:
    return json.loads((REPO / relative).read_text(encoding="utf-8"))


def _version(value: str) -> tuple[int, int, int]:
    parts = value.split(".")
    assert len(parts) == 3 and all(part.isdigit() for part in parts), f"unexpected version {value!r}"
    return tuple(int(part) for part in parts)


def _package_entries(lock: dict, name: str) -> list[tuple[str, dict]]:
    return [
        (path, package)
        for path, package in lock["packages"].items()
        if path == f"node_modules/{name}" or path.endswith(f"/node_modules/{name}")
    ]


class TestProductionDependenciesStayPatched:
    def test_r1_web_and_its_lock_entry_declare_the_patched_next_line(self):
        web = _json("apps/web/package.json")
        lock = _json("package-lock.json")
        workspace = lock["packages"]["apps/web"]

        assert web["dependencies"]["next"] == "^15.5.29", "web must declare the patched Next 15 line"
        assert web["devDependencies"]["eslint-config-next"] == "^15.5.29", (
            "eslint-config-next must stay on the same Next 15 line")
        assert workspace["dependencies"]["next"] == web["dependencies"]["next"], (
            "package-lock.json no longer matches apps/web/package.json")
        assert workspace["devDependencies"]["eslint-config-next"] == web["devDependencies"]["eslint-config-next"], (
            "the locked Next lint configuration drifted from its manifest")
        assert lock["packages"]["node_modules/next"]["version"] == "15.5.29", (
            "the locked Next release moved; re-audit before accepting it")

    def test_r2_next_reuses_a_runtime_safe_postcss_instead_of_a_nested_old_copy(self):
        root = _json("package.json")
        lock = _json("package-lock.json")
        packages = lock["packages"]

        assert root.get("overrides", {}).get("next", {}).get("postcss") == "8.5.33", (
            "Next pins PostCSS 8.4.31; the workspace must override that transitive dependency")
        assert packages["node_modules/next"]["dependencies"]["postcss"] == "8.5.33", (
            "the lock still tells Next to consume its old nested PostCSS")
        assert "node_modules/next/node_modules/postcss" not in packages, (
            "the vulnerable nested PostCSS copy returned")
        assert packages["node_modules/postcss"].get("dev") is not True, (
            "npm prune --omit=dev would remove the PostCSS copy that Next needs at runtime")

    def test_r3_every_locked_copy_of_the_four_audited_packages_meets_its_safe_minimum(self):
        lock = _json("package-lock.json")
        for name, minimum in SAFE_MINIMUMS.items():
            entries = _package_entries(lock, name)
            assert entries, f"package-lock.json has no {name} entry"
            for path, package in entries:
                assert _version(package["version"]) >= minimum, (
                    f"{path} is {package['version']}; production audit requires at least "
                    f"{'.'.join(map(str, minimum))}")
