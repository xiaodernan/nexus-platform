"""NEXUS D99 — one plant for the sweep class.

D98 found that 103 of the gate's 216 assertion names never appear as text in quality.sql: the polymorphic
reference sweeps build them at run time, one row per (table, subject type) the data actually carries. That makes
"give each of the 103 a plant" meaningless — they are one assertion instantiated repeatedly. What is meaningful
is to break ONE edge and show the sweep reddens on exactly that edge, naming it, and on nothing else.

Method, and why it is the shipped text rather than a paraphrase of it: the assertions are sliced out of
data/seed/quality.sql up to the hard-gate marker (the verdict's RAISE would end the session, and the file sets
ON_ERROR_STOP for itself, so the read has to stop before it), and run twice in one session each:

  control   BEGIN; <assertions>; report; ROLLBACK
  plant     BEGIN; UPDATE one facts row's subject_id to a uuid no offering holds; <assertions>; report; ROLLBACK

The diff of the two (check, ok) sets is the witness. ROLLBACK means the database keeps no trace, which is why
the same kept, stamped gate database can be used for both arms and for the residue check afterwards.

  python d99_sweep_plant.py
"""
import subprocess
import os
import sys

REPO = r"D:\获客平台"
TMP = r"C:\Users\18414\AppData\Local\Temp\nexus-d63"
DB = "nexus_gate_225101_1790395370"
REPORT = ("SELECT 'ROW|' || \"check\" || '|' || ok::text FROM qc ORDER BY \"check\";\n")


def psql(text):
    e = dict(os.environ, PGCLIENTENCODING="UTF8")
    p = subprocess.run(["docker", "exec", "-i", "nexus-platform-testpg", "psql", "-U", "postgres", "-d", DB,
                        "-v", "ON_ERROR_STOP=0", "-tA", "-q"], input=text.encode("utf-8"),
                       capture_output=True, cwd=REPO, env=e)
    return p.stdout.decode("utf-8", "replace"), p.stderr.decode("utf-8", "replace")


def assertions():
    text = open(REPO + r"\data\seed\quality.sql", encoding="utf-8").read().replace("\r\n", "\n").split("\n")
    mark = [i for i, l in enumerate(text) if l.startswith("-- ====") and "C  hard gate" in l]
    assert len(mark) == 1
    # the file's own \set ON_ERROR_STOP and its psql meta-commands are kept verbatim; the slice simply ends
    # before the verdict block, which would otherwise abort the session and take the temp table with it
    return "\n".join(text[:mark[0]])


def read_rows(out):
    rows = {}
    for l in out.split("\n"):
        if l.startswith("ROW|"):
            _, name, ok = l.split("|", 2)
            rows[name] = ok
    return rows


body = assertions()
print("assertions sliced: %d lines of the shipped file, verdict block excluded" % len(body.split("\n")))

ctrl_out, ctrl_err = psql("BEGIN;\n" + body + "\n" + REPORT + "\nROLLBACK;\n")
ctrl = read_rows(ctrl_out)
print("control: %d rows filed, %s failing" % (len(ctrl), sum(1 for v in ctrl.values() if v == "false")))

PLANT = """
DO $$
DECLARE t text; v uuid;
BEGIN
  -- the newest seeded subject type that resolves today; take one row and move its subject off anything real
  SELECT f.attribute, gen_random_uuid() INTO t, v
    FROM facts f WHERE f.subject_type = 'offering' LIMIT 1;
  UPDATE facts SET subject_id = v WHERE facts.attribute = t AND facts.subject_type = 'offering'
    AND facts.id = (SELECT id FROM facts WHERE subject_type='offering' LIMIT 1);
  RAISE NOTICE 'plant: one offering fact now points at %', v;
END $$;
"""
plant_out, plant_err = psql("BEGIN;\n" + PLANT + "\n" + body + "\n" + REPORT + "\nROLLBACK;\n")
plant = read_rows(plant_out)

flipped = sorted([n for n in set(ctrl) | set(plant) if ctrl.get(n) != plant.get(n)])
print("plant: %d rows filed; rows whose verdict changed: %d" % (len(plant), len(flipped)))
for n in flipped:
    print("   %s: %s -> %s" % (n, ctrl.get(n, "(absent)"), plant.get(n, "(absent)"))
          if n in ctrl and n in plant else "   %s: appeared only in one arm" % n)
new_rows = sorted(set(plant) - set(ctrl))
gone_rows = sorted(set(ctrl) - set(plant))
print("rows present in one arm only: +%d / -%d %s" % (len(new_rows), len(gone_rows),
                                                      (new_rows + gone_rows)[:3]))
res_out, _ = psql("SELECT 'RES|' || count(*) FROM facts WHERE subject_type='offering'\n"
                  "  AND subject_id NOT IN (SELECT id FROM offerings);\n")
print("residue after both rollbacks, orphan offering-facts in the database itself: %s"
      % [l for l in res_out.split("\n") if l.startswith("RES|")])
ok = (len(flipped) >= 1 and all(v == "false" for k, v in plant.items() if k in flipped)
      and not new_rows and not gone_rows)
print("\nRESULT: %s — the sweep class is live: breaking one edge reddened %d row(s) naming that edge, "
      "and nothing else moved." % ("PASS" if ok else "CHECK", len(flipped)))
open(TMP + r"\d99_plant_out.txt", "w", encoding="utf-8", newline="\n").write(
    "control %d rows, plant %d rows, flipped %s\n%s\n%s" % (len(ctrl), len(plant), flipped,
                                                            ctrl_err[-400:], plant_err[-400:]))
sys.exit(0 if ok else 1)
