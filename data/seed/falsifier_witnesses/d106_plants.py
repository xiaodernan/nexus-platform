"""NEXUS D106 — five more plants, each a write the schema lets through, so the arm is read rather than refused."""
import os, subprocess
REPO = r"D:\获客平台"; DB = "nexus_gate_225101_1790395370"
L = open(REPO + r"\data\seed\quality.sql", encoding="utf-8").read().replace("\r\n","\n").split("\n")
cut = [i for i,l in enumerate(L) if l.startswith("-- ====") and "C  hard gate" in l][0]
BODY = "\n".join(L[:cut]); REPORT = "SELECT 'ROW|' || \"check\" || '|' || ok::text FROM qc ORDER BY \"check\";\n"
def psql(t):
    p = subprocess.run(["docker","exec","-i","nexus-platform-testpg","psql","-U","postgres","-d",DB,
                        "-v","ON_ERROR_STOP=0","-tA","-q"], input=t.encode(), capture_output=True,
                       cwd=REPO, env=dict(os.environ, PGCLIENTENCODING="UTF8"))
    return p.stdout.decode("utf-8","replace"), p.stderr.decode("utf-8","replace")
ARMS = {
 "a document's text changed under its hash": "UPDATE documents SET raw_text = raw_text || ' appended after the hash was taken' WHERE id = (SELECT id FROM documents ORDER BY id LIMIT 1);",
 "a menu document loses its disclaimer": "UPDATE documents SET text = replace(text, 'SYNTHETIC DEMO DATA', 'real data') WHERE id = (SELECT id FROM documents WHERE text ILIKE '%synthetic demo data%' ORDER BY id LIMIT 1);",
 "a user given a non-example email": "UPDATE users SET email = 'chen.wei@gmail.hk' WHERE id = (SELECT id FROM users ORDER BY id LIMIT 1);",
 "a merchant moved out of the HK box": "UPDATE locations SET lat = 31.23, lng = 121.47 WHERE id = (SELECT id FROM locations ORDER BY id LIMIT 1);",
 "a seeded row stamped with today": "UPDATE facts SET updated_at = now() WHERE id = (SELECT id FROM facts ORDER BY id LIMIT 1);",
}
def rows_of(out):
    d={}
    for l in out.split("\n"):
        if l.startswith("ROW|"):
            _,n,ok=l.split("|",2); d[n]=ok
    return d
ctl,_ = psql("BEGIN;\n"+BODY+"\n"+REPORT+"\nROLLBACK;\n"); base=rows_of(ctl)
print("control: %d rows, %d failing" % (len(base), sum(1 for v in base.values() if v=="false")))
res=[]
for arm, w in ARMS.items():
    out, err = psql("BEGIN;\n"+w+"\n"+BODY+"\n"+REPORT+"\nROLLBACK;\n")
    got=rows_of(out); fl=sorted([n for n in got if got[n]!=base.get(n)])
    print("%-38s rows=%-4d flipped=%d %s%s" % (arm, len(got), len(fl), [f[:44] for f in fl[:4]],
          "" if got else "   <- UNREAD: " + ((err.strip().split("\n") or [""])[0][:70])))
    for f in fl: res.append((f, arm))
with open(r"C:\Users\18414\AppData\Local\Temp\nexus-d63\d106_result.tsv","w",encoding="utf-8",newline="\n") as fh:
    for c,a in res: fh.write("%s\tD106\tplant: %s\tnexus-d63/d106_plants.py\n" % (c,a))
r,_ = psql("select 'residue: docs-changed='||count(*) from documents where raw_text like '%appended after the hash%';")
print(r.strip()); print("written %d rows over %d assertions" % (len(res), len(set(c for c,_ in res))))
