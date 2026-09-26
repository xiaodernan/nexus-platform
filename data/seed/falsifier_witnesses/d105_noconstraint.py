"""NEXUS D105 — the question D104 could not ask: if the schema did NOT enforce it, would the gate catch it?

D104's three refused arms wrote nothing, because the database itself stopped them (and because an aborted plant
took the rest of the session down, so "0 rows" was unread rather than green). The interesting assertion is the
one behind the constraint, so this arm drops the constraint inside the transaction, makes the write the schema
normally refuses, runs the shipped assertions, and rolls all of it back — DDL is transactional in Postgres, so
the constraint returns with the rollback and the database is left as found.

Two readings per arm, deliberately separated:
  refused  = the write could not land while the constraint stood (D104 measured that)
  caught   = with the constraint gone, the gate row went false  -> the row is a live backstop
  missed   = with the constraint gone, the gate row stayed true -> the row watches nothing; delete it or say so
"""
import os, subprocess
REPO = r"D:\获客平台"; DB = "nexus_gate_225101_1790395370"
L = open(REPO + r"\data\seed\quality.sql", encoding="utf-8").read().replace("\r\n","\n").split("\n")
cut = [i for i,l in enumerate(L) if l.startswith("-- ====") and "C  hard gate" in l][0]
BODY = "\n".join(L[:cut])
REPORT = "SELECT 'ROW|' || \"check\" || '|' || ok::text FROM qc ORDER BY \"check\";\n"

def psql(text):
    p = subprocess.run(["docker","exec","-i","nexus-platform-testpg","psql","-U","postgres","-d",DB,
                        "-v","ON_ERROR_STOP=0","-tA","-q"], input=text.encode("utf-8"),
                       capture_output=True, cwd=REPO, env=dict(os.environ, PGCLIENTENCODING="UTF8"))
    return p.stdout.decode("utf-8","replace"), p.stderr.decode("utf-8","replace")

def names():
    out, err = psql("select conrelid::regclass||' | '||coalesce(conname,'-')||' | '||contype||' | '||coalesce(indexrelid::regclass::text,'-')"
                    " from pg_constraint where conrelid in ('availability_slots'::regclass,'reviews'::regclass,'facts'::regclass)"
                    " union all select 'idx | '||i.relname||' | u | '||i.relname from pg_class i join pg_index x on x.indexrelid=i.oid"
                    " where x.indrelid in ('facts'::regclass) and i.relname like '%uidx%';")
    return [l for l in out.split("\n") if l.strip()]

print("constraints and unique indexes on the three tables (from the catalog, not from a guess):")
for n in names(): print("   " + n)

TARGETS = {
 "slots: capacity_left within capacity_total": ("availability_slots", "availability_slots_capacity_bounds",
   "UPDATE availability_slots SET capacity_left = capacity_total + 1 WHERE id = (SELECT id FROM availability_slots ORDER BY id LIMIT 1);"),
 "reviews.rating 1..5": ("reviews", "reviews_rating_check",
   "UPDATE reviews SET rating = 6 WHERE id = (SELECT id FROM reviews ORDER BY id LIMIT 1);"),
 "one fact per (subject, attribute)": ("facts", None,
   "INSERT INTO facts (id, subject_type, subject_id, attribute, value, unit, source, confidence, observed_at, expires_at, stale)\n"
   " SELECT gen_random_uuid(), subject_type, subject_id, attribute, value, unit, source, confidence, observed_at, expires_at, stale\n"
   "   FROM facts WHERE id = (SELECT id FROM facts ORDER BY id LIMIT 1);"),
}
ctl, _ = psql("BEGIN;\n" + BODY + "\n" + REPORT + "\nROLLBACK;\n")
base = {}
for line in ctl.split("\n"):
    if line.startswith("ROW|"):
        _, n, ok = line.split("|", 2); base[n] = ok
print("\ncontrol: %d rows, %d failing" % (len(base), sum(1 for v in base.values() if v=="false")))

rows_out = []
for check, (tbl, cons, write) in TARGETS.items():
    drop = ("ALTER TABLE %s DROP CONSTRAINT %s;" % (tbl, cons)) if cons else "DROP INDEX IF EXISTS facts_one_row_per_claim_uidx;"
    sql = "BEGIN;\n" + drop + "\n" + write + "\n" + BODY + "\n" + REPORT + "\nROLLBACK;\n"
    out, err = psql(sql)
    got = {}
    for line in out.split("\n"):
        if line.startswith("ROW|"):
            _, n, ok = line.split("|", 2); got[n] = ok
    if not got:
        print("%-40s -> UNREAD (%s)" % (check, (err.strip().split("\n") or ["?"])[0][:80]))
        continue
    flipped = sorted([n for n in got if got[n] != base.get(n)])
    verdict = "CAUGHT" if check in flipped else ("MISSED" if check in got else "row absent")
    print("%-40s -> %-7s rows=%d flipped=%d %s" % (check, verdict, len(got), len(flipped), [f[:40] for f in flipped[:3]]))
    for f in flipped: rows_out.append((f, check))

with open(r"C:\Users\18414\AppData\Local\Temp\nexus-d63\d105_result.tsv","w",encoding="utf-8",newline="\n") as fh:
    for c, why in rows_out: fh.write("%s\tD105\tplant: %s held without the schema's own constraint\tnexus-d63/d105_noconstraint.py\n" % (c, why))
print("\nwritten %d (check, arm) rows to d105_result.tsv" % len(rows_out))
resid, _ = psql("select 'constraint back in place: '||count(*) from pg_constraint where conname in ('availability_slots_capacity_bounds','reviews_rating_check');")
print(resid.strip())
