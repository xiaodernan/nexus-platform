#!/usr/bin/env python3
"""Put a planted deception in front of the whole shipped gate and report which rows answered.

    python data/seed/falsifier_plants.py --db <gate_db> --container <container>

The database must be a loaded seed -- `scripts/db_gate_fresh.sh --keep` leaves one behind. Nothing here
writes permanently: every run is `BEGIN; plant; whole gate; ROLLBACK` in one psql session, so the same
loaded database serves every session in this file and the last one sees what the loader loaded.

The gate is run **whole** rather than one assertion at a time. A spliced single row answers "did this
predicate move"; the whole file answers the question that actually matters when a row is planted --
*which* rows moved, and whether the fixture broke something other than the thing under test. A plant
that reddens three unrelated rows is evidence about the plant, not about the three (D65's rule that a
falsifying fixture must be legal in every dimension except the one being falsified), so each arm prints
its collateral and the arm is still judged only on whether its own assertion reddened.

Three things are read out of `data/seed/quality.sql` rather than typed here, because a transcription of
any of them would let this file and the shipped gate drift apart and the run would prove nothing:

  * the file's own hard-gate marker, which ends the executable part (the verdict `RAISE` below it would
    end the session before any report could be read);
  * the set of red assertions, taken from the `qc` rows the gate inserted;
  * the check NAMES, also taken from `qc`, so what is reported is the name the gate uses.

Collateral is printed, and one control run explains the largest amount of it. Ten of the first twelve arms
reddened `every column that cannot vary is answered for why it cannot` without being written to: the seed
schema attaches `public.set_updated_at()` (a BEFORE UPDATE trigger, `NEW.updated_at = now()`) to fifteen of
the tables, so *any* single-row UPDATE into one of them un-pins that table's `updated_at`, and the spread
row is exactly the assertion that notices an answer saying "single instant" while the column holds two.
The control at the bottom re-runs one arm with `SET LOCAL session_replication_role = replica` so the
trigger does not fire: same plant, same target redness, collateral gone -- which is what makes the
collateral a measured property of the mutation mechanism rather than an unexplained second failure. The
thirteenth arm is then that finding stated on its own: it changes a timestamp column and nothing else, and
is judged on the spread row itself.

The exit code is 0 only when the baseline matches the two declared known-reds, every arm's assertion
reddened on the plant, no arm's assertion was already red at baseline, and the closing baseline equals
the opening one -- which is how this file knows it left the database as it found it.
"""

import argparse
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
QUALITY = HERE / "quality.sql"

# The two assertions that are red on a database built from the committed migration set, for a reason
# this lane does not own: D108 -- `share_links.subject_type` is named by this file's door vocabulary
# while the migration that creates it has never been committed. An arm that reddens one of these has
# not done anything; an arm that reddens them additionally is a sign the plant moved the schema.
KNOWN_RED = (
    "a CHECK-bounded column is a door vocabulary too",
    "a door vocabulary names a column the schema has",
)

# (marker inside the shipped check name, what the arm plants, the plant)
ARMS = [
    ("phones stay in the reserved", "a merchant given a phone outside the reserved range",
     "UPDATE merchants SET contact = jsonb_set(contact, '{phone}', to_jsonb('9876-5432'::text)) "
     "WHERE id = (SELECT id FROM merchants ORDER BY id LIMIT 1);"),
    ("every source_uri is demo", "a document sourced from a real URL",
     "UPDATE documents SET source_uri = 'https://www.gov.hk/menu.pdf' "
     "WHERE id = (SELECT id FROM documents ORDER BY id LIMIT 1);"),
    ("every source_uri is demo", "a fact sourced from a real URL",
     "UPDATE facts SET source_uri = 'https://www.gov.hk/observation.json' "
     "WHERE id = (SELECT id FROM facts ORDER BY id LIMIT 1);"),
    ("images are local placeholders", "a merchant image pointed at a third-party host",
     "UPDATE merchants SET images = '[{\"url\":\"https://cdn.example.com/shopfront.jpg\","
     "\"alt\":\"frontage\",\"credit\":\"third party\"}]'::jsonb "
     "WHERE id = (SELECT id FROM merchants ORDER BY id LIMIT 1);"),
    ("SEO pages are noindex", "a merchant page indexable by search engines",
     "UPDATE merchants SET seo = jsonb_set(seo, '{noindex}', to_jsonb('false'::text)) "
     "WHERE id = (SELECT id FROM merchants ORDER BY id LIMIT 1);"),
    ("password_hash is the placeholder", "a user carrying a real password hash",
     "UPDATE users SET password_hash = 'e10adc3949ba59abbe56e057f20f883e' "
     "WHERE id = (SELECT id FROM users ORDER BY id LIMIT 1);"),
    # Batch D109: counters, ranges, bodies, coverage and markers -- producers no earlier arm touched.
    ("merchants.review_count matches", "a merchant's published-review counter moved by one",
     "UPDATE merchants SET review_count = review_count + 1 "
     "WHERE id = (SELECT id FROM merchants ORDER BY id LIMIT 1);"),
    ("price_min <= price_max", "an offering whose price band is inverted",
     "UPDATE offerings SET price_max = price_min - 1 "
     "WHERE id = (SELECT id FROM offerings WHERE price_min IS NOT NULL AND price_max IS NOT NULL "
     "ORDER BY id LIMIT 1);"),
    ("review body length", "a review body shortened below the floor",
     "UPDATE reviews SET body = '太好味' "
     "WHERE id = (SELECT id FROM reviews ORDER BY id LIMIT 1);"),
    ("review bodies are not lorem", "a review body that is lorem ipsum",
     "UPDATE reviews SET body = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do "
     "eiusmod tempor.' WHERE id = (SELECT id FROM reviews ORDER BY id LIMIT 1);"),
    ("at least 10 districts covered", "six of the fifteen districts folded into one",
     "UPDATE locations SET district = 'Central' WHERE is_primary AND district IN "
     "(SELECT DISTINCT district FROM locations WHERE is_primary AND district <> 'Central' "
     "ORDER BY district LIMIT 6);"),
    ("disclaimer text is inside every menu", "a menu whose synthetic-data disclaimer was removed",
     "UPDATE documents SET raw_text = replace(raw_text, 'NOT REAL BUSINESSES', 'a real business') "
     "WHERE id = (SELECT id FROM documents ORDER BY id LIMIT 1);"),
    # The spread row's own arm: the only column it moves is a timestamp, which is precisely what that
    # assertion classifies. An ordinary UPDATE reaches it through the trigger; this one says so out loud.
    ("every column that cannot vary", "one merchant's updated_at moved off the single seeded instant",
     "UPDATE merchants SET updated_at = now() "
     "WHERE id = (SELECT id FROM merchants ORDER BY id LIMIT 1);"),
    # Batch D112: the queue is computed, not remembered -- names taken off `qc` and every column the
    # plants touch checked against `pg_attribute` first, so a plant cannot fail as D106's did (a guessed
    # `documents.text` that is an unread arm, not a red one).
    ("raw_text is substantial enough", "a menu document thinned below the RAG floor, disclaimer kept",
     "UPDATE documents SET raw_text = 'Menu listing. NOT REAL BUSINESSES. ' || repeat('dish ', 20) "
     "WHERE id = (SELECT id FROM documents ORDER BY id LIMIT 1);"),
    ("token size inside the", "a chunk counted far above the §7 ceiling",
     "UPDATE chunks SET token_count = 4000 WHERE id = (SELECT id FROM chunks ORDER BY id LIMIT 1);"),
    ("ordinal contiguous per document", "a document's first chunk renumbered out of the sequence",
     "UPDATE chunks SET ordinal = 99 WHERE document_id = "
     "(SELECT document_id FROM chunks ORDER BY document_id LIMIT 1) AND ordinal = 0;"),
    ("category tree: 10 roots", "a leaf promoted to an eleventh root",
     "UPDATE categories SET parent_id = NULL "
     "WHERE id = (SELECT id FROM categories WHERE parent_id IS NOT NULL ORDER BY id LIMIT 1);"),
    ("category_primary is one of the merchant", "a merchant claiming a category it is not mapped to",
     "UPDATE merchants SET category_primary = 'Sichuan-Portuguese fusion' "
     "WHERE id = (SELECT id FROM merchants ORDER BY id LIMIT 1);"),
    ("data_origin = demo everywhere", "a fact whose provenance axis says human",
     "UPDATE facts SET value = jsonb_set(value, '{data_origin}', '\"human\"'::jsonb) "
     "WHERE id = (SELECT id FROM facts ORDER BY id LIMIT 1);"),
]

# The control: arm 0 re-planted with the BEFORE UPDATE trigger switched off, so the same deception is
# the only difference between this run and that arm's. If the collateral is what the D108 measurement
# says it is, the target stays red and the collateral goes to zero.
CONTROL = (0, "SET LOCAL session_replication_role = replica;")
CONTROL_SPREAD = "every column that cannot vary"


def gate_body():
    """The shipped file up to its own hard-gate marker."""
    lines = QUALITY.read_text(encoding="utf-8").replace("\r\n", "\n").split("\n")
    mark = [l for l in lines if l.startswith("-- ====") and "C  hard gate" in l]
    if len(mark) != 1:
        sys.exit(f"FATAL: {len(mark)} hard-gate markers, so the executable part has no safe end")
    return "\n".join(lines[:lines.index(mark[0])])


def run(container, database, sql):
    proc = subprocess.run(
        ["docker", "exec", "-i", container, "psql", "-U", "postgres", "-d", database,
         "-v", "ON_ERROR_STOP=1", "-tA", "-q"],
        input=sql.encode("utf-8"), capture_output=True)
    return proc.stdout.decode("utf-8", "replace"), proc.stderr.decode("utf-8", "replace").strip(), proc.returncode


def gate_under(body, plant, pre=None):
    """One whole run of the shipped gate, optionally after a plant that this transaction undoes."""
    sql = ("BEGIN;\n" + (pre + "\n" if pre else "") + (plant + "\n" if plant else "") + body + "\n"
           + "SELECT 'K|' || count(*) FROM qc;\n"
           + "SELECT 'R|' || \"check\" FROM qc WHERE NOT ok;\nROLLBACK;\n")
    return sql


def parse(out):
    rows = [l[2:] for l in out.split("\n") if l.startswith("K|")]
    reds = sorted(l[2:] for l in out.split("\n") if l.startswith("R|"))
    if not rows:
        return None, []
    return int(rows[0]), reds


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", required=True)
    ap.add_argument("--container", default="nexus-platform-postgres")
    ap.add_argument("--emit-rows", default=None,
                    help="append falsifiers.tsv rows for the arms that reddened and are not already filed")
    ap.add_argument("--unit", default=None, help="ledger number to write into the emitted rows' unit column")
    ap.add_argument("--witness", default=None, help="commit or artifact the emitted rows point at")
    args = ap.parse_args()
    body = gate_body()
    filed = set()
    if args.emit_rows:
        registry = Path(args.emit_rows)
        for line in registry.read_text(encoding="utf-8").split("\n"):
            if line.strip() and not line.startswith("#"):
                parts = line.split("\t")
                if len(parts) >= 3:
                    filed.add((parts[0], parts[2]))

    def gate(plant=None, pre=None):
        out, err, rc = run(args.container, args.db, gate_under(body, plant, pre))
        count, reds = parse(out)
        if rc != 0 or count is None:
            print(f"  run ABORTED rc={rc}: {err[:200]}")
        return count, reds

    base_count, base_reds = gate()
    print(f"baseline, unmutated data: {base_count} assertions, red = {len(base_reds)}")
    for n in base_reds:
        print(f"   {'declared (D108)' if n in KNOWN_RED else 'UNDECLARED   '} {n}")
    failed = [f"baseline red {n} is not declared" for n in base_reds if n not in KNOWN_RED]

    print(f"\n{'arm planted':<54} {'rows':<6} {'target':<8} {'collateral':<11} reddened")
    witnessed = []
    for marker, label, plant in ARMS:
        count, reds = gate(plant)
        if count is None:
            failed.append(f"{label}: run unread")
            continue
        hit = [n for n in reds if marker in n]
        collateral = [n for n in reds if n not in base_reds and n not in hit]
        print(f"{label:<54} {count:<6} {'RED' if hit else 'green':<8} "
              f"{len(collateral):<11} {'; '.join(hit)[:60]}")
        for c in collateral:
            print(f"{'':<54}   collateral: {c[:90]}")
        if len(hit) == 1:
            witnessed.append((hit[0], label))
        elif not hit:
            failed.append(f"{label}: the assertion naming it stayed green")
        else:
            failed.append(f"{label}: {len(hit)} assertions match the marker {marker!r} -- "
                          "the arm is not identified by name")

    idx, pre = CONTROL
    marker, label, plant = ARMS[idx]
    count, reds = gate(plant, pre)
    hit = [n for n in reds if marker in n]
    collateral = [n for n in reds if n not in base_reds and n not in hit]
    spread = [n for n in collateral if CONTROL_SPREAD in n]
    print(f"\ncontrol: arm {idx} ({label}) replanted, triggers off")
    print(f"  target {'RED' if len(hit) == 1 else 'not red'} · collateral {len(collateral)} ·"
          f" spread row {'gone (as predicted: the trigger wrote it)' if not spread else 'STILL RED'}")
    if count is None:
        failed.append("control run unread")
    if len(hit) != 1:
        failed.append("control: the plant stopped falsifying its own assertion when the trigger was disabled")
    if spread:
        failed.append("control: the spread collateral survived without the trigger, so the trigger is not its cause")

    end_count, end_reds = gate()
    same = (end_count, end_reds) == (base_count, base_reds)
    print(f"\nclosing baseline: {end_count} assertions, red = {len(end_reds)} "
          f"({'identical to opening' if same else 'DIFFERS -- the drive left residue'})")
    if not same:
        failed.append("the database changed under the drive")
    print(f"arms run          {len(ARMS)} plus one control, against one loaded database, "
          f"{2 * len(ARMS) + 3} whole-gate sessions, every one rolled back")
    if failed:
        print("RESULT: FAIL -- " + "; ".join(failed))
        return 1
    print("RESULT: PASS -- each planted deception reddened exactly the assertion that names it, "
          "no arm found an undeclared red, and the data is as the loader wrote it")
    if args.emit_rows:
        # Filed only here: a row enters the registry only for an arm that reddened its own assertion
        # under a drive that has now proved it left the database alone.
        new = [(n, label) for n, label in witnessed if (n, label) not in filed and n not in base_reds]
        if not args.unit or not args.witness:
            sys.exit("--emit-rows also needs --unit and --witness")
        with Path(args.emit_rows).open("a", encoding="utf-8", newline="") as fh:
            for n, label in new:
                fh.write(f"{n}\t{args.unit}\t{label}\t{args.witness}\n")
        print(f"registry rows appended: {len(new)} (of {len(witnessed)} arms witnessed)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
