#!/usr/bin/env bash
# The launcher's documented `--log` mode has to work when a human runs it, not only when the e2e does.
#
# Why this exists: `run_platform_dev.sh` is `set -euo pipefail`, and its --log branch expanded `$ROOT` where
# the script defines `root` (lowercase, sixteen lines earlier). Every automated caller — scripts/e2e_fresh.sh
# — exports NEXUS_DEV_LOG and NEXUS_DEV_PID, so the default half of `${NEXUS_DEV_LOG:-$ROOT/...}` was never
# evaluated and the bug stayed invisible; `scripts/run_platform_dev.sh --log`, which that script's own usage
# comment tells a person to type, died with "ROOT: unbound variable" (docs/DECISIONS.md D59).
#
# So this runs the real script with `mvn` stubbed and both overrides absent, which is the human path. The
# default log and pid files are the same ones a running instance appends to, so whatever is there is put back
# before this script leaves — checking the defaults must not truncate somebody else's session.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
work="$(mktemp -d)"
DEFAULTS=(".platform-dev.log" ".platform-dev.pid")

cleanup() {
  # D559: `mktemp -d` and `$root/…` are `C:\…` paths on this host, and the node runtime's
  # safe-delete shim refuses to `rm` them; under `set -e` that failed a run on its cleanup line.
  for f in "${DEFAULTS[@]}"; do
    if [ -f "$work/$f.was-absent" ]; then rm -f "$root/$f" 2>/dev/null || true
    elif [ -f "$work/$f.copy" ]; then cp "$work/$f.copy" "$root/$f"
    fi
  done
  rm -rf "$work" 2>/dev/null || true
}
trap cleanup EXIT

for f in "${DEFAULTS[@]}"; do
  if [ -f "$root/$f" ]; then cp "$root/$f" "$work/$f.copy"; else : > "$work/$f.was-absent"; fi
done

mkdir -p "$work/bin"
printf '#!/usr/bin/env bash\necho "[stub] mvn %s"\nexit 0\n' '"$@"' > "$work/bin/mvn"
chmod +x "$work/bin/mvn"

out="$work/launcher.log"
set +e
( cd "$root" && PATH="$work/bin:$PATH" env -u NEXUS_DEV_LOG -u NEXUS_DEV_PID \
    bash scripts/run_platform_dev.sh --log ) > "$out" 2>&1
rc=$?
set -e

if [ "$rc" -ne 0 ]; then
  echo "FAIL: --log exited $rc for a caller who set nothing:" >&2
  sed -e 's/^/    /' "$out" >&2
  exit 1
fi
if grep -qiE "unbound variable|syntax error|undefined variable" "$out"; then
  echo "FAIL: the launcher broke on its own variable handling:" >&2
  sed -e 's/^/    /' "$out" >&2
  exit 1
fi
if ! grep -q "started in background" "$out"; then
  echo "FAIL: --log never reported a background start:" >&2
  sed -e 's/^/    /' "$out" >&2
  exit 1
fi

echo "PASS: run_platform_dev.sh --log starts for a bare caller; the default log and pid files are as they were"
