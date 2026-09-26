#!/usr/bin/env python3
"""Put each of six planted deceptions in front of its own quality.sql assertion and report which way it went.

    python data/seed/falsifier_plants.py --db <gate_db> --container <container>

The database must be a loaded seed -- scripts/db_gate_fresh.sh --keep leaves one behind. Nothing here
writes permanently: every arm runs inside BEGIN ... ROLLBACK in its own session, so the same database
serves all twelve runs and the last one sees the data the loader loaded.

Two things are derived from data/seed/quality.sql rather than typed out here, because a transcription of
either would let this file and the shipped assertion drift apart and the run would then prove nothing:

  * the assertion body -- the INSERT INTO qc statement whose first line carries the check name, spliced
    verbatim into a session that has created qc the way quality.sql creates it;
  * the check's NAME, read back out of the qc row the spliced statement inserted, so what is reported is
    the name the gate uses, not the name this file meant to test.

Every arm is paired with a control: the same session with no UPDATE. A plant that reddens a check whose
control also reddens has shown nothing, and a control that reddens means the database was not green
before the plant. Both are reported per arm, and the exit code is 0 only when every plant reddened its
own check, every control stayed green, and every run read a row back.
"""

import argparse
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
QUALITY = HERE / "quality.sql"

# (label, sql) -- label is what the registry will call the arm; the check name comes from qc.
ARMS = [
    ("a merchant given a phone outside the reserved range",
     "UPDATE merchants SET contact = jsonb_set(contact, '{phone}', to_jsonb('9876-5432'::text)) "
     "WHERE id = (SELECT id FROM merchants ORDER BY id LIMIT 1);"),
    ("a document sourced from a real URL",
     "UPDATE documents SET source_uri = 'https://www.gov.hk/menu.pdf' "
     "WHERE id = (SELECT id FROM documents ORDER BY id LIMIT 1);"),
    ("a fact sourced from a real URL",
     "UPDATE facts SET source_uri = 'https://www.gov.hk/observation.json' "
     "WHERE id = (SELECT id FROM facts ORDER BY id LIMIT 1);"),
    ("a merchant image pointed at a third-party host",
     "UPDATE merchants SET images = '[{\"url\":\"https://cdn.example.com/shopfront.jpg\","
     "\"alt\":\"frontage\",\"credit\":\"third party\"}]'::jsonb "
     "WHERE id = (SELECT id FROM merchants ORDER BY id LIMIT 1);"),
    ("a merchant page indexable by search engines",
     "UPDATE merchants SET seo = jsonb_set(seo, '{noindex}', 'false') "
     "WHERE id = (SELECT id FROM merchants ORDER BY id LIMIT 1);"),
    ("a user carrying a real password hash",
     "UPDATE users SET password_hash = 'e10adc3949ba59abbe56e057f20f883e' "
     "WHERE id = (SELECT id FROM users ORDER BY id LIMIT 1);"),
]


def assertion_body(text, marker):
    """The shipped INSERT INTO qc whose name line contains `marker`, verbatim."""
    lines = text.split("\n")
    start = [i for i, l in enumerate(lines)
             if l.startswith("INSERT INTO qc") and marker in lines[i + 1]]
    if len(start) != 1:
        sys.exit(f"FATAL: {len(start)} INSERT INTO qc blocks match {marker!r}")
    i = start[0] + 1
    while not lines[i].rstrip().endswith(";"):
        i += 1
    return "\n".join(lines[start[0]:i + 1])


def qc_ddl(text):
    line = [l for l in text.split("\n") if l.startswith("CREATE TEMP TABLE qc")]
    if len(line) != 1:
        sys.exit(f"FATAL: {len(line)} qc declarations found")
    return line[0]


def run(container, database, sql):
    proc = subprocess.run(
        ["docker", "exec", "-i", container, "psql", "-U", "postgres", "-d", database,
         "-v", "ON_ERROR_STOP=1", "-qtA", "-R", "|"],
        input=sql.encode("utf-8"), capture_output=True)
    out = proc.stdout.decode("utf-8", "replace")
    err = proc.stderr.decode("utf-8", "replace").strip()
    return out, err, proc.returncode


def session(ddl, body, plant):
    return ("BEGIN;\n" + ddl + "\n" + (plant + "\n" if plant else "") + body + "\n"
            + "SELECT 'ROW|NAME|' || \"check\" || '|OK|' || coalesce(ok::text,'-')"
            + " || '|DETAIL|' || coalesce(detail,'') FROM qc;\nROLLBACK;\n")


def verdict(ok_text):
    """One word for what qc answered: green, red, or '-' when it answered nothing usable."""
    return {"true": "green", "t": "green", "false": "red", "f": "red"}.get(ok_text.lower(), "-")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", required=True)
    ap.add_argument("--container", default="nexus-platform-postgres")
    args = ap.parse_args()

    text = QUALITY.read_text(encoding="utf-8").replace("\r\n", "\n")
    ddl = qc_ddl(text)
    # One assertion per arm: the source_uri row is an AND of two halves, so it is planted twice.
    targets = [
        ("phones stay in the reserved", ARMS[0]),
        ("every source_uri is demo", ARMS[1]),
        ("every source_uri is demo", ARMS[2]),
        ("images are local placeholders", ARMS[3]),
        ("SEO pages are noindex", ARMS[4]),
        ("password_hash is the placeholder", ARMS[5]),
    ]

    failed = []
    print(f"database {args.db} in {args.container}; every arm is its own rolled-back transaction\n")
    print(f"{'arm':<52} {'control':<9} {'plant':<7} rows  check name read from qc")
    for marker, (label, plant) in targets:
        body = assertion_body(text, marker)
        rows = {}
        for kind, sql in (("control", None), ("plant", plant)):
            out, err, rc = run(args.container, args.db, session(ddl, body, sql))
            rows_read = [l for l in out.split("\n") if l.startswith("ROW|")]
            if rc != 0 or not rows_read:
                print(f"{label:<52} {kind:<9} ABORTED rc={rc} {err[:120]}")
                failed.append(f"{label} ({kind}) did not run")
                rows[kind] = ("error", "error", len(rows_read), "")
                continue
            _, _, name, _, ok, _, detail = rows_read[0].split("|", 6)
            rows[kind] = (name, ok, len(rows_read), detail)

        cname, cok, ccnt, _ = rows["control"]
        pname, pok, pcnt, pdetail = rows["plant"]
        verdict_control = verdict(cok)
        verdict_plant = verdict(pok)
        print(f"{label:<52} {verdict_control:<9} {verdict_plant:<7} "
              f"{pcnt or ccnt:<4} {cname or pname}")
        if ccnt != 1 or pcnt != 1:
            failed.append(f"{label}: a run read {pcnt}/{ccnt} rows, not 1 -- UNREAD, not green")
        if verdict_control != "green":
            failed.append(f"{label}: control was {verdict_control} before any plant")
        if verdict_plant != "red":
            failed.append(f"{label}: plant left the assertion {verdict_plant}")
        print(f"{'':<52} planted detail: {pdetail[:150]}")

    print(f"\narms run        {len(targets)} (each with its own control)")
    if failed:
        print("RESULT: FAIL -- " + "; ".join(failed))
        return 1
    print("RESULT: PASS -- every planted deception was caught by the assertion that names it, "
          "and each of those assertions stayed green on the unmutated data")
    return 0


if __name__ == "__main__":
    sys.exit(main())
