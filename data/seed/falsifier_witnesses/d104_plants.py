"""NEXUS D104 — grow the witness registry by planting five more assertions, each with a producer that exists."""
import os, subprocess
REPO = r"D:\获客平台"; DB = "nexus_gate_225101_1790395370"
L = open(REPO + r"\data\seed\quality.sql", encoding="utf-8").read().replace("\r\n","\n").split("\n")
cut = [i for i,l in enumerate(L) if l.startswith("-- ====") and "C  hard gate" in l][0]
BODY = "\n".join(L[:cut])
REPORT = "SELECT 'ROW|' || \"check\" || '|' || ok::text FROM qc ORDER BY \"check\";\n"

ARMS = {
 "control": "",
 "merchant loses its location": "DELETE FROM locations WHERE id = (SELECT id FROM locations ORDER BY id LIMIT 1);\n",
 "a slot booked beyond capacity": "UPDATE availability_slots SET capacity_left = capacity_total + 1 WHERE id = (SELECT id FROM availability_slots ORDER BY id LIMIT 1);\n",
 "an offering priced out of range": "UPDATE offerings SET price_amount = 25000 WHERE id = (SELECT id FROM offerings WHERE price_amount IS NOT NULL ORDER BY id LIMIT 1);\n",
 "a review rated 6": "UPDATE reviews SET rating = 6 WHERE id = (SELECT id FROM reviews ORDER BY id LIMIT 1);\n",
 "a second fact for one claim": "INSERT INTO facts (id, subject_type, subject_id, attribute, value, unit, source, confidence, observed_at, expires_at, stale)\n"
   " SELECT gen_random_uuid(), subject_type, subject_id, attribute, value, unit, source, confidence, observed_at, expires_at, stale\n"
   "   FROM facts WHERE id = (SELECT id FROM facts ORDER BY id LIMIT 1);\n",
}

def run(sql):
    p = subprocess.run(["docker","exec","-i","nexus-platform-testpg","psql","-U","postgres","-d",DB,
                        "-v","ON_ERROR_STOP=0","-tA","-q"],
                       input=("BEGIN;\n"+sql+BODY+"\n"+REPORT+"\nROLLBACK;\n").encode("utf-8"),
                       capture_output=True, cwd=REPO, env=dict(os.environ, PGCLIENTENCODING="UTF8"))
    rows={}
    for l in p.stdout.decode("utf-8","replace").split("\n"):
        if l.startswith("ROW|"):
            _,n,ok=l.split("|",2); rows[n]=ok
    return rows, p.stderr.decode("utf-8","replace")

base, berr = run(ARMS["control"])
print("control: %d rows, %d failing" % (len(base), sum(1 for v in base.values() if v=="false")))
out=[]
for arm, sql in ARMS.items():
    if arm=="control": continue
    r, err = run(sql)
    flipped=sorted([n for n in r if r[n]!=base.get(n)])
    print("%-28s rows=%d flipped=%d %s" % (arm, len(r), len(flipped), [f[:46] for f in flipped[:4]]))
    if err.strip(): print("      stderr: %s" % err.strip().split("\n")[0][:120])
    for f in flipped: out.append((f, arm))
with open("d104_result.tsv","w",encoding="utf-8",newline="\n") as fh:
    for c,a in out: fh.write("%s\tD104\tplant: %s\tnexus-d63/d104_plants.py\n" % (c,a))
print("\nwitnessed (check, arm) pairs written: %d over %d distinct assertions"
      % (len(out), len(set(c for c,_ in out))))
