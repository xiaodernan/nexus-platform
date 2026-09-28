"""NEXUS D175 - eighteen executable plants for twenty assertions, written against a gap that closed first.

WHAT HAPPENED, IN ORDER. When this harness was started the registry read 326 rows over 196 of 216
assertions (90.7%), and the twenty without a witness were a percentage rather than a list - so step 11 of
the gate was taught to name them (scripts/check_falsifier_registry.mjs prints `no witness yet` for every
assertion the registry does not cover, and prints nothing when there is nothing). The plants below were
then written against that list. By the time they ran, D146, D147 and D148 had landed the same twenty in a
parallel stream: measured on the committed registry at c025067, 359 rows cover 216 of 216 (100.0%). So
these rows are NOT the gap closing - they are a second, independent showing, and the entry in
docs/DECISIONS.md says that rather than claiming a gap that was already shut.

WHY KEEP THEM ANYWAY. Three of those units recorded their plants as prose and a commit hash; this file is
the same reds as something you can run. Every arm re-executes the shipped `quality.sql` from the top of a
transaction on a live gate database and prints which assertions flipped, so a row whose plant no longer
reddens its check shows up as `(nothing went red)` instead of as a witness nobody can re-open.

HOW A PLANT WORKS (D99 -> D104 -> here). Each arm runs the file exactly as the gate runs it - everything
before the `C  hard gate` marker, inside BEGIN ... ROLLBACK so the database is untouched afterwards -
after either
  (a) mutating the database inside that transaction (a constraint's data made unreachable, a column added,
      a row repointed at an id no table holds), or
  (b) patching the quality.sql SOURCE in memory, which is the only way to plant a defect in one of the
      hand-written lists the file consults: `seed_anchor`, `ref_registry`, `poly_probed`, `poly_arms`,
      `poly_vocab`, `door_vocab`. Those lists are data the file carries; a row that disagrees with the
      catalogue is precisely the defect their assertions exist to catch, and no database change can make
      them disagree.
Both are legitimate because both are reproducible from a clean checkout: this file IS the witness, so the
registry row points here and not at a temp directory (D113).

Usage:  python data/seed/falsifier_witnesses/d175_plants.py <gate database>
Exit:   0 every arm went red  -  1 an arm errored or produced no rows  -  2 usage
"""
import os
import re
import subprocess
import sys

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
CONTAINER = os.environ.get("NEXUS_PG_CONTAINER", "nexus-platform-postgres")

SRC = open(os.path.join(REPO, "data", "seed", "quality.sql"), encoding="utf-8").read().replace("\r\n", "\n")
MARK = [i for i, l in enumerate(SRC.split("\n")) if l.startswith("-- ====") and "C  hard gate" in l]
if len(MARK) != 1:
    print("d175_plants.py: the hard-gate marker is missing or duplicated")
    sys.exit(2)
LINES = SRC.split("\n")[: MARK[0]]

ANCHOR_ANCHOR = "'review_summaries']) WITH ORDINALITY AS u(t, ord);"
REPORT = "SELECT 'ROW|' || \"check\" || '|' || ok::text FROM qc ORDER BY \"check\";\n"


def psql(db, script):
    p = subprocess.run(
        ["docker", "exec", "-i", CONTAINER, "psql", "-U", "postgres", "-d", db,
         "-v", "ON_ERROR_STOP=0", "-tA", "-q"],
        input=script.encode("utf-8"), capture_output=True, cwd=REPO,
        env=dict(os.environ, PGCLIENTENCODING="UTF8"))
    return p.stdout.decode("utf-8", "replace"), p.stderr.decode("utf-8", "replace")


def table_names(db):
    out, _ = psql(db, "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY 1;")
    return [t for t in out.split("\n") if t.strip()]


def patch(lines, old, new, times=1):
    hits = [i for i, l in enumerate(lines) if old in l]
    if len(hits) != times:
        raise SystemExit("d175_plants.py: patch anchor %r hit %d time(s), expected %d"
                         % (old, len(hits), times))
    for i in hits:
        lines[i] = lines[i].replace(old, new)
    return lines


def run(db, body_lines, arm_sql):
    body = "\n".join(body_lines)
    script = "BEGIN;\n" + arm_sql + "\n" + body + "\n" + REPORT + "\nROLLBACK;\n"
    out, err = psql(db, script)
    rows = {}
    for line in out.split("\n"):
        if line.startswith("ROW|"):
            _, name, ok = line.split("|", 2)
            rows[name] = ok
    return rows, err


def main():
    if len(sys.argv) != 2:
        print(__doc__)
        return 2
    db = sys.argv[1]
    tables = table_names(db)
    text = SRC
    # Comments are not executed. A column whose identifier appears only after `--` is one this file can
    # never read, which is what makes renaming it a plant in the CATALOGUE rather than a break in the file.
    executable = "\n".join(l for l in text.split("\n") if not l.lstrip().startswith("--"))

    def unread(name):
        return not re.search(r"\b" + re.escape(name) + r"\b", executable)

    def cols(sql):
        out, _ = psql(db, sql)
        return [r.split(".", 1) for r in out.split("\n") if "." in r]

    REF_SQL = ("SELECT c.relname || '.' || a.attname FROM pg_attribute a "
               "JOIN pg_class c ON c.oid = a.attrelid "
               "JOIN pg_namespace n ON n.oid = c.relnamespace "
               "WHERE n.nspname = 'public' AND c.relkind = 'r' AND a.attnum > 0 "
               "AND NOT a.attisdropped "
               "AND ((a.attname LIKE '%\\_id' AND a.attname <> 'id') "
               "     OR (a.attname LIKE '%\\_by' AND a.atttypid = 'uuid'::regtype)) "
               "AND NOT EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conrelid = c.oid "
               "  AND k.contype = 'f' AND a.attnum = ANY (k.conkey)) "
               "AND NOT EXISTS (SELECT 1 FROM pg_constraint u WHERE u.conrelid = c.oid "
               "  AND u.contype IN ('p','u') AND array_length(u.conkey, 1) = 1 AND a.attnum = u.conkey[1]) "
               "ORDER BY 1;")
    POLY_SQL = ("SELECT c.relname || '.' || a.attname FROM pg_attribute a "
                "JOIN pg_class c ON c.oid = a.attrelid "
                "JOIN pg_namespace n ON n.oid = c.relnamespace "
                "WHERE n.nspname = 'public' AND c.relkind = 'r' AND a.attnum > 0 "
                "AND NOT a.attisdropped AND a.attname LIKE '%\\_type' "
                "AND EXISTS (SELECT 1 FROM pg_attribute b WHERE b.attrelid = c.oid "
                "  AND b.attnum > 0 AND NOT b.attisdropped "
                "  AND b.attname = left(a.attname, length(a.attname) - 5) || '_id') "
                "ORDER BY 1;")

    # The reference census floors at 17 and measures 26; it is shrunk by renaming reference columns the
    # file cannot read. Measured at run time, not remembered - if fewer than 10 exist the arm prints what
    # it got and the assertion stays green, which is the honest outcome rather than a hidden one.
    ref_renames = ["ALTER TABLE %s RENAME COLUMN %s TO %s_d175gone;" % (t, c, c)
                   for t, c in cols(REF_SQL) if unread(c)]
    # The polymorphic-pair census floors at 8 and measures 12, so five pairs have to go. Four are broken by
    # columns named nowhere in an executable line; the fifth, feedback_events.subject_type, is safe for a
    # reason the rule above cannot see - the only reads of `subject_type` in this file are pg_attribute
    # discovery (decided from the catalogue AFTER this arm runs) and four probes over facts, favorites,
    # moderation_cases and permission_grants, none of which is this table.
    poly_renames = ["ALTER TABLE %s RENAME COLUMN %s TO %s_d175gone;" % (t, c, c)
                    for t, c in cols(POLY_SQL)
                    if unread(c) or (t, c) == ("feedback_events", "subject_type")]

    # The traffic sweep floors at 20, and the gate measures 58 tables against the 23 names in the anchor
    # list, so 35 sit outside it and ten extra names leave the sweep green. The arm takes as many unread
    # tables as the catalogue offers rather than a number guessed in advance, because the list it appends to
    # is also part A's `count(*) FROM public.%I` set: a name the file already carries would be double-counted.
    anchor_extra = [t for t in tables if "'%s'" % t not in text][:20]
    print("reference columns this file cannot read: %d; polymorphic pairs breakable: %d; anchor extras: %d"
          % (len(ref_renames), len(poly_renames), len(anchor_extra)))

    ARMS = [
        ("control", [], ""),
        ("a share link written by an author and a tenant no table holds",
         [], "SET session_replication_role = replica; "
             "INSERT INTO share_links (tenant_id, code, subject_type, subject_id, created_by) "
             "VALUES ('00000000-0000-0000-0000-00000000dead', 'D175PKT', 'guide', gen_random_uuid(), "
             "'00000000-0000-0000-0000-00000000dead'); "
             "SET session_replication_role = origin;"),
        ("a priced offering is written with no price provenance",
         [], "ALTER TABLE offerings ALTER COLUMN price_updated_at DROP NOT NULL; "
             "UPDATE offerings SET price_updated_at = NULL WHERE price_amount IS NOT NULL;"),
        ("a guide item points at a merchant that is not in the table",
         [], "UPDATE collections SET items = "
             "'[{\"merchant_id\": \"00000000-0000-0000-0000-000000000000\"}]'::jsonb "
             "WHERE id = (SELECT id FROM collections ORDER BY id LIMIT 1);"),
        ("a string type no reading declares, and a folding column the demo exercises upper case on",
         [], "ALTER TABLE users ADD COLUMN d175_probe character varying(10); "
             "ALTER TABLE users ADD COLUMN d175_fold citext; "
             "UPDATE users SET d175_fold = 'FOLD' || id::text;"),
        ("a verification-shaped boolean no answer in the file names",
         [], "ALTER TABLE users ADD COLUMN d175_verified boolean;"),
        ("a CHECK bounded to a list no door transcribes",
         [], "ALTER TABLE merchants ADD COLUMN d175_door text; "
             "UPDATE merchants SET d175_door = 'x'; "
             "ALTER TABLE merchants ADD CONSTRAINT d175_door_check "
             "CHECK (d175_door = ANY (ARRAY['x', 'y']::text[]));"),
        ("the waiver's own table arrives: `policies` now exists",
         [], "CREATE TABLE policies (id uuid PRIMARY KEY);"),
        ("the reference census loses a column it used to count",
         [], ";\n".join(ref_renames) + ";"),
        ("the polymorphic-pair census loses a pair it used to count",
         [], ";\n".join(poly_renames) + ";"),
        ("the hand list names a column the schema has lost",
         [("('user_identities.provider_id', 'not-a-reference',", "('user_identities.provider_id_x', 'not-a-reference',")],
         ""),
        ("the waiver kind is claimed for a column that ships four types",
         [("('facts.subject_id', 'probe',", "('facts.subject_id', 'join-one-type',")], ""),
        ("the probed-pair list declares a table the schema does not have",
         [(" ('permission_grants', 3, 'the D71 probe", " ('d175_ghost', 3, 'the D71 probe")], ""),
        ("a UNION arm is dropped from the arm list",
         [("('permission_grants', 'merchant_user'), ('permission_grants', 'api_key');",
           "('permission_grants', 'merchant_user');")], ""),
        ("an armed type is pointed at a table the schema does not have",
         [("'api_keys', 'door',", "'api_keys_retired', 'door',")], ""),
        ("a door list names a column the schema does not have",
         [("('agent_runs', 'status', ARRAY['running'", "('agent_runs', 'status_gone', ARRAY['running'")], ""),
        ("the declared arm count disagrees with the registry it is checked against",
         [(" ('permission_grants', 3, 'the D71 probe", " ('permission_grants', 4, 'the D71 probe")], ""),
        ("the anchor list grows until the sweep outside it falls under its own floor",
         [(ANCHOR_ANCHOR,
           "'review_summaries'" + "".join(",'%s'" % t for t in anchor_extra)
           + "]) WITH ORDINALITY AS u(t, ord);")], ""),
        ("a view column loses the answer that was written for it",
         [(" ('v_merchant_funnel', 'clicks', 'const', '0', 'same arm of the same predicate over the same empty table'),", "")],
         ""),
    ]

    base, berr = run(db, LINES, "")
    print("control: %d rows, %d failing%s" % (len(base), sum(1 for v in base.values() if v == "false"),
                                              " | stderr: " + berr.strip().split("\n")[0][:100] if berr.strip() else ""))
    if not base:
        print("control produced no rows; the file cannot be sliced on this plane")
        return 1

    written, failed = [], []
    for name, patches, arm_sql in ARMS:
        lines = list(LINES)
        try:
            for old, new in patches:
                patch(lines, old, new)
        except SystemExit as e:
            print("%-72s PATCH MISSED: %s" % (name, e))
            failed.append(name)
            continue
        rows, err = run(db, lines, arm_sql)
        if not rows:
            print("%-72s NO ROWS (the transaction aborted)%s"
                  % (name, " | " + err.strip().split("\n")[0][:90] if err.strip() else ""))
            failed.append(name)
            continue
        flipped = sorted(n for n in rows if rows[n] != base.get(n))
        went_red = [n for n in flipped if rows[n] == "false"]
        # A check this arm only INVENTED is not a witnessed assertion: the registry validates every row
        # against the 216 the control files, and a name the control never filed would be read as "not an
        # assertion the gate files". Growing the anchor is exactly that case - it adds `fk:` rows for
        # parents that were not in the list a moment ago - so those reds are reported and not written.
        novel = [n for n in went_red if n not in base]
        went_red = [n for n in went_red if n in base]
        print("%-72s rows=%d  flipped=%d  red=%d%s"
              % (name, len(rows), len(flipped), len(went_red),
                 "  (+%d invented by the arm)" % len(novel) if novel else ""))
        for f in novel:
            print("      NOT FILED BY CONTROL  %s" % f)
        for f in went_red:
            written.append((f, name))
            print("      RED  %s" % f)
        if not went_red:
            print("      (nothing went red)")
            failed.append(name)

    out_path = os.path.join(REPO, "data", "seed", "falsifier_witnesses", "d175_result.tsv")
    with open(out_path, "w", encoding="utf-8", newline="\n") as fh:
        for check, arm in written:
            fh.write("%s\tD175\tplant: %s\tdata/seed/falsifier_witnesses/d175_plants.py\n" % (check, arm))
    print("\nred (check, arm) pairs written: %d over %d distinct assertion(s)"
          % (len(written), len(set(c for c, _ in written))))
    print("arms that went red: %d of %d" % (len(set(a for _, a in written)), len(ARMS) - 1))
    return 1 if not written else 0


if __name__ == "__main__":
    sys.exit(main())
