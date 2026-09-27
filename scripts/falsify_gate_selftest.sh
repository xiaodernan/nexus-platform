#!/bin/bash
# Falsifier for gate step 11's ENTRY POINT (D150 wired it, D151 shows it holds).
#
# `db_gate_fresh.sh` runs the text-plane anchor guard as
#     ( cd "$ROOT" && "${PYTHON:-python}" data/seed/falsifier_plants.py --self-test ) 2>&1 | sed ...
# so the guard's exit code travels through a pipe. A pipe is where an exit code goes to die unless
# `set -o pipefail` holds it, and reading that line at the top of the gate is an argument about shell
# semantics, not a measurement of this gate. This script is the mutation: it returns 1 when and only
# when it is asked to run `--self-test`, and hands every other call to the real interpreter, so a
# gate that dies inside step 11 died because of the guard's return code and for no other reason.
#
#   PYTHON="$PWD/scripts/falsify_gate_selftest.sh" bash scripts/db_gate_fresh.sh
#
# Predicted and measured (D151, 2026-09-28): steps 1-10 print the control run's lines unchanged,
# step 11 prints this file's MUTATED line, the registry reader never starts, step 12 never runs, the
# gate exits 1, and the EXIT trap still drops the run's database. The control is a run of the same
# gate with the real interpreter: `RESULT: PASS` at 216 checks and `gate rc=0`.
for arg in "$@"; do
  if [ "$arg" = "--self-test" ]; then
    echo "text-plane self-test, MUTATED: the guard returns 1 without looking at the body"
    exit 1
  fi
done
exec python "$@"
