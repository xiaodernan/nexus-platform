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

Whole-gate mode also polices the aim, not just the plant. A `target green` line is this file's way of
saying "the assertion named here does not read what this SQL moves" -- an arm that set
`facts.value->>'data_origin'` did redden four rows, none of them the one it claimed, because the plain
`data_origin` columns and the jsonb key of the same name are watched by different assertions. A spliced
run would have called that green. Each arm therefore names the assertion its own SQL reaches, and the two
`data_origin` arms are the same deception stated on the two planes that watch it.

Existence is the third thing a session is judged on, and it was found by being missed. A sweep that builds
its names with `GROUP BY` files *nothing* when the table it groups over is emptied, so such an assertion
neither goes green nor goes red -- it stops existing, and a comparison of red sets cannot see a row that is
not there. D119's facts-delete arm filed 213 rows against a 216 baseline and the drive still reported PASS,
because the only trace was a number in a printed column. An arm may now declare the names it unfiles (an
optional fourth tuple element); an undeclared disappearance fails the drive.

The exit code is 0 only when the baseline matches the two declared known-reds, every arm's assertion
reddened on the plant, no arm's assertion was already red at baseline, no assertion stopped being filed
without being declared, and the closing baseline equals the opening one -- which is how this file knows it
left the database as it found it.
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
    # D112's first aim at this row was wrong and the whole-gate run said so: the plant moved
    # facts.value->>'data_origin' while `data_origin = demo everywhere the column exists` predicates only
    # over the three plain columns, so it stayed green and the deception landed on a different row. This is
    # that other row -- the one that actually watches the jsonb key.
    ("provenance axis and the §109 stamp axis stay separate", "a fact whose stamp axis says human",
     "UPDATE facts SET value = jsonb_set(value, '{data_origin}', '\"human\"'::jsonb) "
     "WHERE id = (SELECT id FROM facts ORDER BY id LIMIT 1);"),
    # ...and the row that was first aimed at is now aimed at properly: one plain merchant column off
    # 'demo'. pg_attribute shows no CHECK on merchants.data_origin, so the schema will not refuse this,
    # which is exactly why the plain-column assertion has to be the thing that catches it.
    ("data_origin = demo everywhere", "a merchant stamped human instead of demo",
     "UPDATE merchants SET data_origin = 'human' WHERE id = (SELECT id FROM merchants ORDER BY id LIMIT 1);"),
    # Batch D118: the VALUE plane. Every earlier arm fabricates something textual -- a URL, a marker, a
    # name, a body -- but most of the gate is numeric doors (bounds, TTLs, ratios, referential counts),
    # and a bound that has only ever been watched while the data obeyed it is untested in the direction
    # that matters. Each plant here was first measured legal: `pg_constraint` shows no CHECK touching
    # merchants.popularity_score, facts.expires_at, facts.stale, reviews.language or
    # permission_grants.granted_by, so the schema lets all five through and only the gate can notice.
    # That is the point of the batch -- these assertions are the last line, not a backstop.
    ("popularity_score within", "a merchant popularity score above the declared ceiling",
     "UPDATE merchants SET popularity_score = 1.4 "
     "WHERE id = (SELECT id FROM merchants ORDER BY id LIMIT 1);"),
    ("price facts respect", "a price fact stamped with the hours TTL instead of the six-hour one",
     "UPDATE facts SET expires_at = observed_at + interval '12 hours' "
     "WHERE id = (SELECT id FROM facts WHERE attribute = 'price' ORDER BY id LIMIT 1);"),
    ("some facts are deliberately stale", "the stale-marking cleared, so the UI would never show 已過時",
     "UPDATE facts SET stale = false WHERE stale;"),
    ("language mix ~60%", "2,500 Cantonese reviews relabelled English, dropping the share under 50%",
     "UPDATE reviews SET language = 'en' WHERE id IN "
     "(SELECT id FROM reviews WHERE language = 'zh-HK' ORDER BY id LIMIT 2500);"),
    ("every grant names an operator", "a grant filed by an operator id that no user holds",
     "UPDATE permission_grants SET granted_by = '00000000-0000-4000-8000-0000000000d1' "
     "WHERE id = (SELECT id FROM permission_grants WHERE granted_by IS NOT NULL ORDER BY id LIMIT 1);"),
    ("no merchant name collides", "a merchant renamed to a real HK chain on the §109 blocklist",
     "UPDATE merchants SET display_name_zh = '翠華餐廳' "
     "WHERE id = (SELECT id FROM merchants ORDER BY id LIMIT 1);"),
    # Batch D119: the VOLUME family. Six of these names could not be reached by any fabricated value,
    # because every one of them reads `counts` -- a snapshot of `count(*)` taken at the top of the gate --
    # so the only deception that moves them is the size of a table. Each was aimed from `pg_constraint`
    # first, exactly as D118's were aimed from `pg_attribute`: which tables point at the target, and with
    # which ON DELETE rule. Measured on a loaded seed (merchants 520 against a floor of 500, offerings
    # 5,534/5,000, reviews 11,000/10,000, documents 1,040 vs merchants 520, chunks 2,118, facts 5,688),
    # with carts/cart_items/order_items/reservations/handoffs all at zero rows -- so the NO ACTION
    # referencers of merchants and offerings cannot refuse these deletes. The aim is chosen to keep every
    # OTHER volume row green, which is what makes each arm a witness for one assertion: far-from-Sha-Tin
    # merchants (a bbox of lat < 22.30 or lng > 114.25 is at least 7 km from 22.3831/114.1876, so the
    # density row cannot notice) with the fewest reviews; offerings no review, fact or document references;
    # reviews deleted in the table's own 31/69 language split so the mix row cannot notice; documents
    # ordered by their chunk count with at least one left per merchant so `chunks > 0` survives.
    # The last two arms have no such aim: `> 0` can only be falsified by emptying the table, so their
    # collateral is expected to be wide and is printed rather than minimised.
    ("volume: merchants", "21 of the 520 merchants removed, the count under the declared floor",
     "DELETE FROM merchants WHERE id IN (SELECT m.id FROM merchants m "
     "JOIN locations l ON l.merchant_id = m.id AND l.is_primary "
     "WHERE l.lat < 22.30 OR l.lng > 114.25 "
     "ORDER BY (SELECT count(*) FROM reviews r WHERE r.merchant_id = m.id) ASC, m.id ASC LIMIT 21);"),
    ("volume: offerings", "535 offerings removed, none of them referenced by anything",
     "DELETE FROM offerings o WHERE o.id IN (SELECT o2.id FROM offerings o2 "
     "WHERE NOT EXISTS (SELECT 1 FROM reviews r WHERE r.offering_id = o2.id) "
     "AND NOT EXISTS (SELECT 1 FROM facts f WHERE f.subject_id = o2.id) "
     "AND NOT EXISTS (SELECT 1 FROM documents d WHERE d.offering_id = o2.id) "
     "ORDER BY o2.id LIMIT 535);"),
    ("volume: reviews", "1,001 reviews removed in the table's own language ratio",
     "DELETE FROM reviews WHERE id IN (SELECT id FROM reviews WHERE language = 'en' ORDER BY id LIMIT 310); "
     "DELETE FROM reviews WHERE id IN (SELECT id FROM reviews WHERE language = 'zh-HK' ORDER BY id LIMIT 691);"),
    ("volume: documents >= merchants", "521 documents removed, so one fewer than the merchant count",
     "DELETE FROM documents WHERE id IN (SELECT d.id FROM documents d "
     "WHERE NOT (d.id = (SELECT d2.id FROM documents d2 WHERE d2.merchant_id = d.merchant_id ORDER BY d2.id LIMIT 1)) "
     "ORDER BY (SELECT count(*) FROM chunks c WHERE c.document_id = d.id) ASC, d.id LIMIT 520); "
     # documents(1,040) >= merchants(520) has a margin of exactly the merchant count, so the protected sweep
     # above lands on 520 = 520 -- legal, and not a falsification. Breaking the tie needs one merchant to
     # lose its last document; the lowest id takes it deterministically.
     "DELETE FROM documents WHERE id = (SELECT id FROM documents ORDER BY id LIMIT 1);"),
    ("volume: chunks > 0", "every chunk removed -- a presence row has no narrower falsifier",
     "DELETE FROM chunks;"),
    # This arm is the one that empties a table a sweep builds its NAMES from, so three assertions stop
    # existing rather than going red (D119): quality.sql:381 files `orphan: facts.<type>` one row per
    # subject_type present, and with no facts there is no subject_type. Declaring them is what keeps
    # "the plane shrank" a fact about this arm instead of a number nobody read.
    ("volume: facts > 0", "every fact removed -- the same presence row on the table with no CHECKs",
     "DELETE FROM facts;",
     ("orphan: facts.location", "orphan: facts.merchant", "orphan: facts.offering")),
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


def sql_lit(s):
    return "'" + s.replace("'", "''") + "'"


def gate_under(body, plant, pre=None, expect=(), baseline=False):
    """One whole run of the shipped gate, optionally after a plant that this transaction undoes.

    The report is read back as aggregated single rows wherever a name can appear, because a `qc` name is
    built by whoever wrote the assertion: one name per line would let a newline inside a name change what
    this file counts. chr(31) is the separator, and the X| row is the precondition for that -- the
    baseline run refuses to proceed if any live name carries a control character this protocol would
    split on. `expect` is the baseline name list; the M| row comes back holding the names this session
    stopped filing altogether.
    """
    vals = ", ".join("(" + sql_lit(n) + ")" for n in expect)
    sql = ("BEGIN;\n" + (pre + "\n" if pre else "") + (plant + "\n" if plant else "") + body + "\n"
           + "SELECT 'K|' || count(*) FROM qc;\n"
           + 'SELECT \'R|\' || "check" FROM qc WHERE NOT ok;\n')
    if baseline:
        sql += ("SELECT 'X|' || count(*) FROM qc WHERE"
                " position(chr(31) in \"check\") + position(chr(10) in \"check\")"
                " + position(chr(13) in \"check\") + position(chr(9) in \"check\") > 0;\n"
                + 'SELECT \'N|\' || string_agg("check", chr(31) ORDER BY "check") FROM qc;\n')
    if expect:
        sql += ("SELECT 'M|' || coalesce(string_agg(x, chr(31) ORDER BY x), '') FROM"
                " (SELECT v.x FROM (VALUES " + vals + ") v(x)"
                ' WHERE NOT EXISTS (SELECT 1 FROM qc WHERE qc."check" = v.x)) s;\n')
    return sql + "ROLLBACK;\n"


def parse(out):
    def one(tag):
        rows = [l[2:] for l in out.split("\n") if l.startswith(tag)]
        return rows[0] if rows else None

    count, unsafe = one("K|"), one("X|")
    reds = sorted(l[2:] for l in out.split("\n") if l.startswith("R|"))
    split = lambda v: [x for x in v.split(chr(31)) if x.strip()] if v else []
    if count is None:
        return None, [], [], [], unsafe
    return int(count), reds, split(one("N|")), split(one("M|")), unsafe


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", required=True)
    ap.add_argument("--container", default="nexus-platform-postgres")
    ap.add_argument("--emit-rows", default=None,
                    help="append falsifiers.tsv rows for every assertion this drive reddened -- the arm's own "
                         "and the collateral ones -- that is not already filed under that arm")
    ap.add_argument("--unit", default=None, help="ledger number to write into the emitted rows' unit column")
    ap.add_argument("--witness", default=None, help="commit or artifact the emitted rows point at")
    ap.add_argument("--only", default=None,
                    help="run just the arms whose marker or label contains this string: a whole-gate session "
                         "is the expensive half of a drive, and aiming one arm should not cost thirty-five")
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

    sessions = 0

    def gate(plant=None, pre=None, expect=(), baseline=False):
        nonlocal sessions
        out, err, rc = run(args.container, args.db, gate_under(body, plant, pre, expect, baseline))
        count, reds, names, missing, unsafe = parse(out)
        if rc != 0 or count is None:
            print(f"  run ABORTED rc={rc}: {err[:200]}")
        else:
            sessions += 1
        return count, reds, names, missing, unsafe

    base_count, base_reds, base_names, _, unsafe = gate(baseline=True)
    if base_count is None:
        sys.exit("FATAL: the baseline session returned nothing to read")
    if unsafe and int(unsafe):
        sys.exit(f"FATAL: {unsafe} live check name(s) carry a tab, newline or chr(31), so the aggregated"
                 " report rows this drive parses would not survive the transport")
    print(f"baseline, unmutated data: {base_count} assertions, red = {len(base_reds)}")
    for n in base_reds:
        print(f"   {'declared (D108)' if n in KNOWN_RED else 'UNDECLARED   '} {n}")
    failed = [f"baseline red {n} is not declared" for n in base_reds if n not in KNOWN_RED]

    arms = [a for a in ARMS if args.only is None or args.only in a[0] or args.only in a[1]]
    if not arms:
        sys.exit(f"FATAL: --only {args.only!r} selected none of the {len(ARMS)} arms")
    print(f"\n{'arm planted':<54} {'rows':<6} {'target':<8} {'collateral':<11} unfiled  reddened")
    witnessed, collateral_witnessed = [], []
    for arm in arms:
        marker, label, plant = arm[0], arm[1], arm[2]
        declared = arm[3] if len(arm) > 3 else ()
        count, reds, _, missing, _ = gate(plant, expect=base_names)
        if count is None:
            failed.append(f"{label}: run unread")
            continue
        hit = [n for n in reds if marker in n]
        collateral = [n for n in reds if n not in base_reds and n not in hit]
        undeclared = [n for n in missing if n not in declared]
        print(f"{label:<54} {count:<6} {'RED' if hit else 'green':<8} "
              f"{len(collateral):<11} {len(missing):<8} {'; '.join(hit)[:60]}")
        for c in collateral:
            print(f"{'':<54}   collateral: {c[:90]}")
        for n in missing:
            print(f"{'':<54}   {'unfiled, declared: ' if not undeclared else 'UNFILED, UNDECLARED: '}{n[:80]}")
        if undeclared:
            failed.append(f"{label}: {len(undeclared)} assertion(s) stopped being filed and the arm declares "
                          f"none: {'; '.join(undeclared)}")
        if len(hit) == 1:
            witnessed.append((hit[0], label))
            collateral_witnessed += [(c, label) for c in collateral]
        elif not hit:
            failed.append(f"{label}: the assertion naming it stayed green")
        else:
            failed.append(f"{label}: {len(hit)} assertions match the marker {marker!r} -- "
                          "the arm is not identified by name")

    idx, pre = CONTROL
    marker, label, plant = ARMS[idx][:3]
    ran_control = any(a[0] == marker for a in arms)
    if ran_control:
        count, reds, _, missing, _ = gate(plant, pre, expect=base_names)
        hit = [n for n in reds if marker in n]
        collateral = [n for n in reds if n not in base_reds and n not in hit]
        spread = [n for n in collateral if CONTROL_SPREAD in n]
        print(f"\ncontrol: arm {idx} ({label}) replanted, triggers off")
        print(f"  target {'RED' if len(hit) == 1 else 'not red'} · collateral {len(collateral)} ·"
              f" unfiled {len(missing)} ·"
              f" spread row {'gone (as predicted: the trigger wrote it)' if not spread else 'STILL RED'}")
        if count is None:
            failed.append("control run unread")
        if len(hit) != 1:
            failed.append("control: the plant stopped falsifying its own assertion when the trigger was disabled")
        if spread:
            failed.append("control: the spread collateral survived without the trigger, so the trigger is not its cause")
        if missing:
            failed.append(f"control: {len(missing)} assertion(s) stopped being filed, which no arm declared")
    else:
        print(f"\ncontrol: skipped, because --only {args.only!r} excluded arm {idx}")

    end_count, end_reds, _, end_missing, _ = gate(expect=base_names)
    # The name list itself only comes back on the baseline session; what the closing one proves is that
    # every baseline name is still being filed, which is the same claim read the cheap way.
    same = (end_count, end_reds) == (base_count, base_reds) and not end_missing
    print(f"\nclosing baseline: {end_count} assertions, red = {len(end_reds)}"
          f"{', ' + str(len(end_missing)) + ' name(s) no longer filed' if end_missing else ''} "
          f"({'identical to opening' if same else 'DIFFERS -- the drive left residue'})")
    if not same:
        failed.append("the database changed under the drive")
    print(f"arms run          {len(arms)} of {len(ARMS)}"
          f"{' plus one control' if ran_control else ''}, against one loaded database, "
          f"{sessions} whole-gate sessions, every one counted and rolled back")
    if failed:
        print("RESULT: FAIL -- " + "; ".join(failed))
        return 1
    print("RESULT: PASS -- each planted deception reddened exactly the assertion that names it, "
          "no arm found an undeclared red, no assertion left the plane undeclared, "
          "and the data is as the loader wrote it")
    if args.emit_rows:
        # Filed only here: a row enters the registry only for an assertion reddened under a drive that has
        # now proved it left the database alone. Collateral counts too, because D103's standard is "shown
        # able to fail" and a red the gate filed for a reason the arm also moves is a demonstration -- the
        # arm column says honestly which arm it was, since it is the arm that ran.
        if not args.unit or not args.witness:
            sys.exit("--emit-rows also needs --unit and --witness")
        pairs = [(n, label) for n, label in witnessed + collateral_witnessed
                 if (n, label) not in filed and n not in base_reds]
        seen, new = set(), []
        for pair in pairs:
            if pair[0] not in seen:
                seen.add(pair[0])
                new.append(pair)
        with Path(args.emit_rows).open("a", encoding="utf-8", newline="") as fh:
            for n, label in new:
                fh.write(f"{n}\t{args.unit}\t{label}\t{args.witness}\n")
        targets = {n for n, _ in witnessed}
        print(f"registry rows appended: {len(new)} "
              f"({sum(1 for n, _ in new if n in targets)} from the arm's own target, "
              f"{sum(1 for n, _ in new if n not in targets)} from its collateral)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
