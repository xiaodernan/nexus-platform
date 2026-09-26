"""NEXUS D100 — the remaining polymorphic sweeps, one plant each.

D99 proved the class live on `facts`. A plant in one table is not a plant in another: each sweep resolves its own
subject-type vocabulary through its own probe CTE, so each gets its own broken edge. Four arms, one session each,
every write inside a transaction that is rolled back:

  control        no plant
  favorites      one row's subject_id moved to a uuid no favorite target holds
  permission_grants  likewise (the 36 seeded grants are all merchant_user)
  moderation_cases   likewise (the 544 seeded cases are all review)

Each arm reports the full (check, ok) set, and the diff against control is the witness.
"""
import os, subprocess

REPO = r"D:\获客平台"; DB = "nexus_gate_225101_1790395370"
REPORT = "SELECT 'ROW|' || \"check\" || '|' || ok::text FROM qc ORDER BY \"check\";\n"

def psql(text):
    p = subprocess.run(["docker","exec","-i","nexus-platform-testpg","psql","-U","postgres","-d",DB,
                        "-v","ON_ERROR_STOP=0","-tA","-q"], input=text.encode("utf-8"),
                       capture_output=True, cwd=REPO, env=dict(os.environ, PGCLIENTENCODING="UTF8"))
    return p.stdout.decode("utf-8","replace")

lines = open(REPO + r"\data\seed\quality.sql", encoding="utf-8").read().replace("\r\n","\n").split("\n")
cut = [i for i,l in enumerate(lines) if l.startswith("-- ====") and "C  hard gate" in l]
assert len(cut)==1
BODY = "\n".join(lines[:cut[0]])

PLANTS = {
 "control": "",
 "favorites": "UPDATE favorites SET subject_id = gen_random_uuid() WHERE id = (SELECT id FROM favorites ORDER BY id LIMIT 1);\n",
 "permission_grants": "UPDATE permission_grants SET subject_id = gen_random_uuid() WHERE id = (SELECT id FROM permission_grants ORDER BY id LIMIT 1);\n",
 "moderation_cases": "UPDATE moderation_cases SET subject_id = gen_random_uuid() WHERE id = (SELECT id FROM moderation_cases ORDER BY id LIMIT 1);\n",
}

def run(sql):
    out = psql("BEGIN;\n" + sql + "\n" + BODY + "\n" + REPORT + "\nROLLBACK;\n")
    rows = {}
    for l in out.split("\n"):
        if l.startswith("ROW|"):
            _, name, ok = l.split("|", 2); rows[name] = ok
    return rows

res = {k: run(v) for k, v in PLANTS.items()}
base = res["control"]
print("control: %d rows, %s failing" % (len(base), sum(1 for v in base.values() if v=="false")))
bad = 0
for arm in ("favorites","permission_grants","moderation_cases"):
    r = res[arm]
    flipped = sorted([n for n in r if r[n] != base.get(n)])
    sweep = [n for n in flipped if n.startswith("orphan: ")]
    other = [n for n in flipped if not n.startswith("orphan: ")]
    ok = len(sweep)==1 and all(r[n]=="false" for n in flipped) and len(r)==len(base)
    bad += 0 if ok else 1
    print("%s %-19s rows=%d flipped=%d  sweep=%s  cascade=%s"
          % ("ok " if ok else "BAD", arm, len(r), len(flipped), sweep, [c[:44] for c in other]))
resid = psql("SELECT 'RES|' || (SELECT count(*) FROM favorites f WHERE NOT EXISTS (SELECT 1 FROM offerings o WHERE o.id::text=f.subject_id::text AND f.subject_type='offering')) || '-' || (SELECT count(*) FROM moderation_cases WHERE subject_id NOT IN (SELECT id FROM reviews)) || '-' || (SELECT count(*) FROM permission_grants WHERE subject_id NOT IN (SELECT user_id FROM merchant_users));")
print("residue (favourite-offering orphans, case-review orphans, grant-user orphans): %s" % [l for l in resid.split("\n") if l.startswith("RES|")])
print("\nRESULT: %s — three more sweeps each reddened on their own broken edge." % ("PASS" if bad==0 else "CHECK(%d)"%bad))
