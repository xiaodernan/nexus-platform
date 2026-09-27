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

The `fk: ` sweep needed a third case, because no legal write can falsify it: the constraint the row names is
the same thing that refuses the write. Nine arms (D122) therefore open with `SET LOCAL
session_replication_role = replica` and say so in their label -- measured to silence foreign keys and triggers
while leaving CHECKs and NOT NULLs in force, so the SET reaches the referential state and nothing else, and the
same SET with nothing moved leaves 216 rows and 0 red. What such an arm witnesses is that the ASSERTION detects
an orphan, never that a door could produce one. The tenth arm takes the route a deployment can take instead --
drop the constraint, then orphan a row -- and it is not a falsifier of an `fk: ` row at all: the sweep is
generated from `pg_constraint`, so that edge's name stops existing and D66's census row is what reddens.

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
    # merchants (the bbox lat < 22.30 OR lng > 114.25 lies at least 6.4 km from 22.3831/114.1876 in the
    # limit, and the 62 rows it actually selects measure 10.51-18.23 km out over pg_temp.haversine_m, so
    # the density row's own 3 km radius cannot notice) with the fewest reviews; offerings no review, fact
    # or document references;
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

    # Batch D121: the polymorphic seam. Both earlier planes move a value or a row count; these three move the
    # TARGET of a (subject_type, subject_id) pair, which no CHECK and no foreign key covers -- measured over
    # pg_constraint, `favorites` carries one FK (user_id, CASCADE) and `facts` one (merchant_id, CASCADE), and
    # `subject_id` is in neither. The two favourite arms are the deception the probe at quality.sql:302 is
    # written for: a favourite saved under the wrong label, which assertSubjectInTenant refuses at the door,
    # so the id stays a real row and only the type lies. The facts arm is the same lie on the other side --
    # a merchant fact whose subject_id names an offering -- aimed at attribute='opening_hours' so the price
    # TTL and rating rows keep their own witnesses uncontested.
    ("orphan: favorites.collection", "the one collection favourite pointed at the guide row",
     "UPDATE favorites SET subject_id = (SELECT id FROM collections WHERE kind = 'guide' ORDER BY id LIMIT 1) "
     "WHERE subject_type = 'collection';"),
    ("orphan: favorites.guide", "the one guide favourite pointed at a collection row",
     "UPDATE favorites SET subject_id = (SELECT id FROM collections WHERE kind = 'collection' ORDER BY id LIMIT 1) "
     "WHERE subject_type = 'guide';"),
    ("orphan: facts.merchant", "one merchant fact re-keyed onto an offering's id",
     "UPDATE facts SET subject_id = (SELECT id FROM offerings ORDER BY id LIMIT 1) "
     "WHERE id = (SELECT id FROM facts WHERE subject_type = 'merchant' AND attribute = 'opening_hours' "
     "ORDER BY id LIMIT 1);"),

    # Batch D122: the `fk: ` sweep, which no legal write can reach because the constraint enforces every one of
    # it. The route is to write the row the constraint refuses, and the only thing that must be true of such a
    # plant is that it says so on its own face: each arm below opens with `SET LOCAL session_replication_role =
    # replica`, and the label repeats it, because the witness is about what the ASSERTION detects, not about
    # what a door can produce. Measured before filing (scratch sessions, each rolled back): the SET alone with
    # nothing moved leaves 216 rows and 0 red, so the mechanism is not what reddens anything; and the role
    # silences foreign keys and triggers only -- `SET LOCAL ... replica` then rating=9.9 is still refused by
    # reviews_rating_check and body=NULL still by the not-null constraint, both measured -- so the arms cannot
    # smuggle a value-plane deception past a value-plane assertion. Eight of these nine edges were measured to
    # redden exactly their own name with zero collateral and no name born or vanished; the ninth,
    # moderation_cases.assigned_to, is different in kind: 544 cases and 0 of them carry an assignee, so the
    # sweep row is green for want of data and the arm has to file the column before it can dangle it.
    #
    # The tenth arm is the failure a deployment CAN take -- a migration that stops enforcing the edge -- and it
    # does not falsify an `fk: ` row at all. Dropping the constraint and orphaning a row leaves 215 assertions:
    # the sweep is generated from pg_constraint, so the name for that edge stops existing, and what goes red
    # instead is D66's census row, which reads the same catalogue and notices the edge left the probed set. The
    # vanished name is therefore declared here rather than filed, which is exactly the case D120's fourth tuple
    # was built for.
    ("fk: business_hours.location_id -> locations.id",
     "fk checks off (replica role): a business_hours row loses its location",
     "SET LOCAL session_replication_role = replica; "
     "UPDATE business_hours SET location_id = gen_random_uuid() WHERE id = "
     "(SELECT id FROM business_hours ORDER BY id LIMIT 1);"),
    ("fk: categories.parent_id -> categories.id",
     "fk checks off (replica role): a child category loses its parent",
     "SET LOCAL session_replication_role = replica; "
     "UPDATE categories SET parent_id = gen_random_uuid() WHERE id = "
     "(SELECT id FROM categories WHERE parent_id IS NOT NULL ORDER BY id LIMIT 1);"),
    ("fk: collections.author_id -> users.id",
     "fk checks off (replica role): a collection loses its author",
     "SET LOCAL session_replication_role = replica; "
     "UPDATE collections SET author_id = gen_random_uuid() WHERE id = "
     "(SELECT id FROM collections WHERE author_id IS NOT NULL ORDER BY id LIMIT 1);"),
    ("fk: user_preferences.user_id -> users.id",
     "fk checks off (replica role): a preference loses its user",
     "SET LOCAL session_replication_role = replica; "
     "UPDATE user_preferences SET user_id = gen_random_uuid() WHERE (user_id, key) = "
     "(SELECT user_id, key FROM user_preferences ORDER BY 1, 2 LIMIT 1);"),
    ("fk: merchant_categories.category_id -> categories.id",
     "fk checks off (replica role): a merchant-category link loses its category",
     "SET LOCAL session_replication_role = replica; "
     "UPDATE merchant_categories SET category_id = gen_random_uuid() WHERE (merchant_id, category_id) = "
     "(SELECT merchant_id, category_id FROM merchant_categories ORDER BY 1, 2 LIMIT 1);"),
    ("fk: availability_slots.pool_id -> resource_pools.id",
     "fk checks off (replica role): a slot loses its resource pool",
     "SET LOCAL session_replication_role = replica; "
     "UPDATE availability_slots SET pool_id = gen_random_uuid() WHERE id = "
     "(SELECT id FROM availability_slots ORDER BY id LIMIT 1);"),
    ("fk: chunks.tenant_id -> tenants.id",
     "fk checks off (replica role): a chunk loses its tenant",
     "SET LOCAL session_replication_role = replica; "
     "UPDATE chunks SET tenant_id = gen_random_uuid() WHERE id = (SELECT id FROM chunks ORDER BY id LIMIT 1);"),
    ("fk: favorites.user_id -> users.id",
     "fk checks off (replica role): a favourite loses its owner",
     "SET LOCAL session_replication_role = replica; "
     "UPDATE favorites SET user_id = gen_random_uuid() WHERE id = (SELECT id FROM favorites ORDER BY id LIMIT 1);"),
    ("fk: moderation_cases.assigned_to -> users.id",
     "fk checks off: a case gains an assignee that is nobody (0 of 544 carry one)",
     "SET LOCAL session_replication_role = replica; "
     "UPDATE moderation_cases SET assigned_to = gen_random_uuid() WHERE id = "
     "(SELECT id FROM moderation_cases ORDER BY id LIMIT 1);"),
    ("every reference the seed writes",
     "fk: enforcement dropped, then one row lands on the unenforced edge",
     "ALTER TABLE user_preferences DROP CONSTRAINT user_preferences_user_id_fkey; "
     "UPDATE user_preferences SET user_id = gen_random_uuid() WHERE (user_id, key) = "
     "(SELECT user_id, key FROM user_preferences ORDER BY 1, 2 LIMIT 1);",
     ("fk: user_preferences.user_id -> users.id",)),

    # Batch D123: the ten next names on §131's populated-child list. Before aiming, each column was read out of
    # the kept database (rows total, rows carrying a value, the constraints it sits in, any CHECK naming it) --
    # scratch d123_aim.sql. Two things came out of that census and both are this batch's business. First, no
    # column in the ten carries a CHECK and none is a primary key, so `WHERE id = (SELECT id ... LIMIT 1)` is a
    # legal handle for every one of them; the seven that are part of some UNIQUE constraint are safe for the
    # same reason the D122 arms were, since a gen_random_uuid() cannot collide with an existing composite key.
    # Second, "populated child table" turned out to be the wrong plane to count on: two of the thirty-two names
    # §131 called reachable sit on columns that carry no value at all -- categories.tenant_id on 77 rows and
    # documents.offering_id on 1040, both 0 non-null -- so their sweep row is green for want of data, not for
    # want of an orphan, and they need a D122-style value-filing plant rather than an UPDATE. Those two wait
    # for their own batch. The ten here all carry a value in every row, so each is one UPDATE.
    ("fk: availability_slots.merchant_id -> merchants.id",
     "fk checks off (replica role): a slot loses its merchant",
     "SET LOCAL session_replication_role = replica; "
     "UPDATE availability_slots SET merchant_id = gen_random_uuid() WHERE id = "
     "(SELECT id FROM availability_slots ORDER BY id LIMIT 1);"),
    ("fk: business_hours.merchant_id -> merchants.id",
     "fk checks off (replica role): a set of opening hours loses its merchant",
     "SET LOCAL session_replication_role = replica; "
     "UPDATE business_hours SET merchant_id = gen_random_uuid() WHERE id = "
     "(SELECT id FROM business_hours ORDER BY id LIMIT 1);"),
    ("fk: chunks.document_id -> documents.id",
     "fk checks off (replica role): a chunk loses its document",
     "SET LOCAL session_replication_role = replica; "
     "UPDATE chunks SET document_id = gen_random_uuid() WHERE id = "
     "(SELECT id FROM chunks ORDER BY id LIMIT 1);"),
    ("fk: chunks.merchant_id -> merchants.id",
     "fk checks off (replica role): a chunk loses its merchant",
     "SET LOCAL session_replication_role = replica; "
     "UPDATE chunks SET merchant_id = gen_random_uuid() WHERE id = "
     "(SELECT id FROM chunks ORDER BY id LIMIT 1);"),
    ("fk: collections.tenant_id -> tenants.id",
     "fk checks off (replica role): a collection loses its tenant (4 rows in the table)",
     "SET LOCAL session_replication_role = replica; "
     "UPDATE collections SET tenant_id = gen_random_uuid() WHERE id = "
     "(SELECT id FROM collections ORDER BY id LIMIT 1);"),
    ("fk: documents.merchant_id -> merchants.id",
     "fk checks off (replica role): a document loses its merchant",
     "SET LOCAL session_replication_role = replica; "
     "UPDATE documents SET merchant_id = gen_random_uuid() WHERE id = "
     "(SELECT id FROM documents ORDER BY id LIMIT 1);"),
    ("fk: documents.tenant_id -> tenants.id",
     "fk checks off (replica role): a document loses its tenant",
     "SET LOCAL session_replication_role = replica; "
     "UPDATE documents SET tenant_id = gen_random_uuid() WHERE id = "
     "(SELECT id FROM documents ORDER BY id LIMIT 1);"),
    ("fk: facts.merchant_id -> merchants.id",
     "fk checks off (replica role): a fact loses its merchant",
     "SET LOCAL session_replication_role = replica; "
     "UPDATE facts SET merchant_id = gen_random_uuid() WHERE id = "
     "(SELECT id FROM facts ORDER BY id LIMIT 1);"),
    ("fk: locations.merchant_id -> merchants.id",
     "fk checks off (replica role): a location loses its merchant",
     "SET LOCAL session_replication_role = replica; "
     "UPDATE locations SET merchant_id = gen_random_uuid() WHERE id = "
     "(SELECT id FROM locations ORDER BY id LIMIT 1);"),
    ("fk: locations.tenant_id -> tenants.id",
     "fk checks off (replica role): a location loses its tenant",
     "SET LOCAL session_replication_role = replica; "
     "UPDATE locations SET tenant_id = gen_random_uuid() WHERE id = "
     "(SELECT id FROM locations ORDER BY id LIMIT 1);"),

    # Batch D124: the rest of the populated-child list, so this closes that half of the `fk: ` family and leaves
    # only the 50 names whose child table the seed never writes. The census behind the aim is scratch
    # d124_aim.sql, run against the kept loaded database, and it printed rows / non-null / the primary key /
    # every UNIQUE index containing the column / every CHECK on the table. Four findings shaped the batch:
    #   * no CHECK on any of the thirteen tables names one of these 22 columns, so none of these plants carries a
    #     value-plane lie alongside the reference lie (the D122 `rating = 99` confound cannot recur here);
    #   * three columns are sparse -- resource_pools.offering_id on 7 of 452, reviews.offering_id on 2055 of
    #     11000, reviews.user_id on 245 of 11000 -- so `ORDER BY id LIMIT 1` can land on a NULL and quietly turn
    #     "an existing edge is cut" into "a value was invented". Every dense arm here therefore selects its row
    #     with `<col> IS NOT NULL`, which the D122/D123 arms did not need;
    #   * two tables have no `id` column at all -- merchant_categories' key is (merchant_id, category_id) and
    #     offering_relations' is (from_offering, to_offering, relation) -- and in three cases the column IS part
    #     of that key, so the handle is the whole tuple and the new value must be fresh, which gen_random_uuid()
    #     is;
    #   * the two columns §123 deferred are here as value-FILING plants, D122's moderation_cases shape:
    #     categories.tenant_id is NULL on all 77 rows and documents.offering_id on all 1040, so their sweep row
    #     is green for want of data, and the only plant that reaches them invents the first value. Each label
    #     says so, because a witness that files a value proves less than one that moves a value.
    ("fk: categories.tenant_id -> tenants.id",
     "fk checks off (replica role): a category gains a tenant that is nobody (0 of 77 carry one)",
     "SET LOCAL session_replication_role = replica; "
     "UPDATE categories SET tenant_id = gen_random_uuid() WHERE id = "
     "(SELECT id FROM categories WHERE tenant_id IS NULL ORDER BY id LIMIT 1);"),
    ("fk: documents.offering_id -> offerings.id",
     "fk checks off (replica role): a document gains an offering that is nobody (0 of 1040 carry one)",
     "SET LOCAL session_replication_role = replica; "
     "UPDATE documents SET offering_id = gen_random_uuid() WHERE id = "
     "(SELECT id FROM documents WHERE offering_id IS NULL ORDER BY id LIMIT 1);"),
    ("fk: merchant_categories.merchant_id -> merchants.id",
     "fk checks off (replica role): a merchant-category link loses its merchant (keyed on the PK pair, no id)",
     "SET LOCAL session_replication_role = replica; "
     "UPDATE merchant_categories SET merchant_id = gen_random_uuid() WHERE (merchant_id, category_id) = "
     "(SELECT merchant_id, category_id FROM merchant_categories ORDER BY 1, 2 LIMIT 1);"),
    ("fk: merchants.tenant_id -> tenants.id",
     "fk checks off (replica role): a merchant loses its tenant",
     "SET LOCAL session_replication_role = replica; "
     "UPDATE merchants SET tenant_id = gen_random_uuid() WHERE id = "
     "(SELECT id FROM merchants WHERE tenant_id IS NOT NULL ORDER BY id LIMIT 1);"),
    ("fk: merchant_users.merchant_id -> merchants.id",
     "fk checks off (replica role): a workspace member loses its merchant (3 rows in the table)",
     "SET LOCAL session_replication_role = replica; "
     "UPDATE merchant_users SET merchant_id = gen_random_uuid() WHERE id = "
     "(SELECT id FROM merchant_users WHERE merchant_id IS NOT NULL ORDER BY id LIMIT 1);"),
    ("fk: merchant_users.user_id -> users.id",
     "fk checks off (replica role): a workspace member stops being anybody (3 rows in the table)",
     "SET LOCAL session_replication_role = replica; "
     "UPDATE merchant_users SET user_id = gen_random_uuid() WHERE id = "
     "(SELECT id FROM merchant_users WHERE user_id IS NOT NULL ORDER BY id LIMIT 1);"),
    ("fk: moderation_cases.tenant_id -> tenants.id",
     "fk checks off (replica role): a moderation case loses its tenant",
     "SET LOCAL session_replication_role = replica; "
     "UPDATE moderation_cases SET tenant_id = gen_random_uuid() WHERE id = "
     "(SELECT id FROM moderation_cases WHERE tenant_id IS NOT NULL ORDER BY id LIMIT 1);"),
    ("fk: offering_relations.from_offering -> offerings.id",
     "fk checks off (replica role): a related-offering edge loses its near end (PK column, keyed on the pair)",
     "SET LOCAL session_replication_role = replica; "
     "UPDATE offering_relations SET from_offering = gen_random_uuid() WHERE (from_offering, to_offering) = "
     "(SELECT from_offering, to_offering FROM offering_relations WHERE from_offering IS NOT NULL "
     "ORDER BY 1, 2 LIMIT 1);"),
    ("fk: offering_relations.to_offering -> offerings.id",
     "fk checks off (replica role): a related-offering edge loses its far end (PK column, keyed on the pair)",
     "SET LOCAL session_replication_role = replica; "
     "UPDATE offering_relations SET to_offering = gen_random_uuid() WHERE (from_offering, to_offering) = "
     "(SELECT from_offering, to_offering FROM offering_relations WHERE to_offering IS NOT NULL "
     "ORDER BY 1, 2 LIMIT 1);"),
    ("fk: offerings.category_id -> categories.id",
     "fk checks off (replica role): an offering loses its category",
     "SET LOCAL session_replication_role = replica; "
     "UPDATE offerings SET category_id = gen_random_uuid() WHERE id = "
     "(SELECT id FROM offerings WHERE category_id IS NOT NULL ORDER BY id LIMIT 1);"),
    ("fk: offerings.merchant_id -> merchants.id",
     "fk checks off (replica role): an offering loses its merchant",
     "SET LOCAL session_replication_role = replica; "
     "UPDATE offerings SET merchant_id = gen_random_uuid() WHERE id = "
     "(SELECT id FROM offerings WHERE merchant_id IS NOT NULL ORDER BY id LIMIT 1);"),
    ("fk: offerings.tenant_id -> tenants.id",
     "fk checks off (replica role): an offering loses its tenant",
     "SET LOCAL session_replication_role = replica; "
     "UPDATE offerings SET tenant_id = gen_random_uuid() WHERE id = "
     "(SELECT id FROM offerings WHERE tenant_id IS NOT NULL ORDER BY id LIMIT 1);"),
    ("fk: permission_grants.merchant_id -> merchants.id",
     "fk checks off (replica role): a grant stops being a grant over anyone's data (36 rows in the table)",
     "SET LOCAL session_replication_role = replica; "
     "UPDATE permission_grants SET merchant_id = gen_random_uuid() WHERE id = "
     "(SELECT id FROM permission_grants WHERE merchant_id IS NOT NULL ORDER BY id LIMIT 1);"),
    ("fk: resource_pools.merchant_id -> merchants.id",
     "fk checks off (replica role): a resource pool loses its merchant",
     "SET LOCAL session_replication_role = replica; "
     "UPDATE resource_pools SET merchant_id = gen_random_uuid() WHERE id = "
     "(SELECT id FROM resource_pools WHERE merchant_id IS NOT NULL ORDER BY id LIMIT 1);"),
    ("fk: resource_pools.offering_id -> offerings.id",
     "fk checks off (replica role): a resource pool loses the offering it is stocked for (7 of 452 carry one)",
     "SET LOCAL session_replication_role = replica; "
     "UPDATE resource_pools SET offering_id = gen_random_uuid() WHERE id = "
     "(SELECT id FROM resource_pools WHERE offering_id IS NOT NULL ORDER BY id LIMIT 1);"),
    ("fk: reviews.merchant_id -> merchants.id",
     "fk checks off (replica role): a review loses its merchant",
     "SET LOCAL session_replication_role = replica; "
     "UPDATE reviews SET merchant_id = gen_random_uuid() WHERE id = "
     "(SELECT id FROM reviews WHERE merchant_id IS NOT NULL ORDER BY id LIMIT 1);"),
    ("fk: reviews.offering_id -> offerings.id",
     "fk checks off (replica role): a review stops being about anything sellable (2055 of 11000 carry one)",
     "SET LOCAL session_replication_role = replica; "
     "UPDATE reviews SET offering_id = gen_random_uuid() WHERE id = "
     "(SELECT id FROM reviews WHERE offering_id IS NOT NULL ORDER BY id LIMIT 1);"),
    ("fk: reviews.tenant_id -> tenants.id",
     "fk checks off (replica role): a review loses its tenant",
     "SET LOCAL session_replication_role = replica; "
     "UPDATE reviews SET tenant_id = gen_random_uuid() WHERE id = "
     "(SELECT id FROM reviews WHERE tenant_id IS NOT NULL ORDER BY id LIMIT 1);"),
    ("fk: reviews.user_id -> users.id",
     "fk checks off (replica role): a review stops being anyone's (245 of 11000 carry one)",
     "SET LOCAL session_replication_role = replica; "
     "UPDATE reviews SET user_id = gen_random_uuid() WHERE id = "
     "(SELECT id FROM reviews WHERE user_id IS NOT NULL ORDER BY id LIMIT 1);"),
    ("fk: user_identities.tenant_id -> tenants.id",
     "fk checks off (replica role): an identity loses its tenant (5 rows in the table)",
     "SET LOCAL session_replication_role = replica; "
     "UPDATE user_identities SET tenant_id = gen_random_uuid() WHERE id = "
     "(SELECT id FROM user_identities WHERE tenant_id IS NOT NULL ORDER BY id LIMIT 1);"),
    ("fk: user_identities.user_id -> users.id",
     "fk checks off (replica role): an identity stops belonging to a user (5 rows in the table)",
     "SET LOCAL session_replication_role = replica; "
     "UPDATE user_identities SET user_id = gen_random_uuid() WHERE id = "
     "(SELECT id FROM user_identities WHERE user_id IS NOT NULL ORDER BY id LIMIT 1);"),
    ("fk: users.tenant_id -> tenants.id",
     "fk checks off (replica role): a user loses their tenant (5 rows in the table)",
     "SET LOCAL session_replication_role = replica; "
     "UPDATE users SET tenant_id = gen_random_uuid() WHERE id = "
     "(SELECT id FROM users WHERE tenant_id IS NOT NULL ORDER BY id LIMIT 1);"),
    # Batch D125: the 50 `fk: ` names D124 leaves behind are on child tables the seed leaves EMPTY, so
    # the sweep resolves 0 of 0 there and no UPDATE can reach them. This shape reaches them: a legal
    # INSERT first -- constraint checks still ON, so the row satisfies every FK, CHECK and NOT NULL the
    # schema has -- and then the same dangle behind the switched-off role. Two things follow and the
    # ledger states both. The insert is not a falsification; it is a reachability claim about the
    # schema, and it is the first one this lane has ever been able to make on these tables. The dangle
    # happens in a state quality.sql forbids on the artifact: any row outside the anchor reddens
    # `no traffic outside the seeded tables` in every session below, so each of these arms carries two
    # reds, and the second one is that assertion's own door test rather than noise. share_links is left
    # out of the batch: its 2 names exist only on another lane's uncommitted migration (#75), so a
    # witness there would not reopen on the committed schema.
    ("fk: agent_profiles.merchant_id -> merchants.id",
     "synthetic traffic row: an agent profile points at a merchant that is nobody (0 rows in the table)",
     "INSERT INTO agent_profiles (merchant_id, protocol, version) VALUES "
     "((SELECT id FROM merchants ORDER BY id LIMIT 1), 'a2a', '1.0'); "
     "SET LOCAL session_replication_role = replica; "
     "UPDATE agent_profiles SET merchant_id = gen_random_uuid() WHERE id = "
     "(SELECT id FROM agent_profiles ORDER BY id LIMIT 1);"),
    ("fk: agent_runs.tenant_id -> tenants.id",
     "synthetic traffic row: an agent run belongs to a tenant that is nobody (0 rows in the table)",
     "INSERT INTO agent_runs (tenant_id, agent) VALUES "
     "((SELECT id FROM tenants ORDER BY id LIMIT 1), 'research'); "
     "SET LOCAL session_replication_role = replica; "
     "UPDATE agent_runs SET tenant_id = gen_random_uuid() WHERE id = "
     "(SELECT id FROM agent_runs ORDER BY id LIMIT 1);"),
    ("fk: api_keys.merchant_id -> merchants.id",
     "synthetic traffic row: an API key is issued by a merchant that is nobody (0 rows in the table)",
     "INSERT INTO api_keys (merchant_id, name, key_hash, prefix) VALUES "
     "((SELECT id FROM merchants ORDER BY id LIMIT 1), 'plant key', '0123456789abcdef', 'nx_'); "
     "SET LOCAL session_replication_role = replica; "
     "UPDATE api_keys SET merchant_id = gen_random_uuid() WHERE id = "
     "(SELECT id FROM api_keys ORDER BY id LIMIT 1);"),
    ("fk: audit_logs.tenant_id -> tenants.id",
     "synthetic traffic row: an audit entry is filed under a tenant that is nobody (0 rows in the table)",
     "INSERT INTO audit_logs (tenant_id, actor_type, action) VALUES "
     "((SELECT id FROM tenants ORDER BY id LIMIT 1), 'user', 'plant.d125'); "
     "SET LOCAL session_replication_role = replica; "
     "UPDATE audit_logs SET tenant_id = gen_random_uuid() WHERE id = "
     "(SELECT id FROM audit_logs ORDER BY id LIMIT 1);"),
    ("fk: deletion_requests.user_id -> users.id",
     "synthetic traffic row: a deletion request is nobody's (0 rows in the table)",
     "INSERT INTO deletion_requests (user_id, kind) VALUES "
     "((SELECT id FROM users ORDER BY id LIMIT 1), 'account'); "
     "SET LOCAL session_replication_role = replica; "
     "UPDATE deletion_requests SET user_id = gen_random_uuid() WHERE id = "
     "(SELECT id FROM deletion_requests ORDER BY id LIMIT 1);"),
    ("fk: events.tenant_id -> tenants.id",
     "synthetic traffic row: an event is counted for a tenant that is nobody (0 rows in the table)",
     "INSERT INTO events (tenant_id, name) VALUES "
     "((SELECT id FROM tenants ORDER BY id LIMIT 1), 'plant.d125'); "
     "SET LOCAL session_replication_role = replica; "
     "UPDATE events SET tenant_id = gen_random_uuid() WHERE id = "
     "(SELECT id FROM events ORDER BY id LIMIT 1);"),
    ("fk: review_summaries.merchant_id -> merchants.id",
     "synthetic traffic row: a review summary belongs to a merchant that is nobody (0 rows in the table)",
     "INSERT INTO review_summaries (merchant_id, overall) VALUES "
     "((SELECT id FROM merchants ORDER BY id LIMIT 1), 4.20); "
     "SET LOCAL session_replication_role = replica; "
     "UPDATE review_summaries SET merchant_id = gen_random_uuid() WHERE merchant_id = "
     "(SELECT merchant_id FROM review_summaries ORDER BY 1 LIMIT 1);"),
    ("fk: saved_searches.user_id -> users.id",
     "synthetic traffic row: a saved search is nobody's (0 rows in the table)",
     "INSERT INTO saved_searches (user_id, query) VALUES "
     "((SELECT id FROM users ORDER BY id LIMIT 1), 'tee near central'); "
     "SET LOCAL session_replication_role = replica; "
     "UPDATE saved_searches SET user_id = gen_random_uuid() WHERE id = "
     "(SELECT id FROM saved_searches ORDER BY id LIMIT 1);"),
    ("fk: subscriptions.merchant_id -> merchants.id",
     "synthetic traffic row: a subscription bills a merchant that is nobody (0 rows in the table)",
     "INSERT INTO subscriptions (merchant_id, plan) VALUES "
     "((SELECT id FROM merchants ORDER BY id LIMIT 1), 'pro'); "
     "SET LOCAL session_replication_role = replica; "
     "UPDATE subscriptions SET merchant_id = gen_random_uuid() WHERE id = "
     "(SELECT id FROM subscriptions ORDER BY id LIMIT 1);"),
    ("fk: trust_signals.merchant_id -> merchants.id",
     "synthetic traffic row: a trust signal vouches for a merchant that is nobody (0 rows in the table)",
     "INSERT INTO trust_signals (merchant_id, kind) VALUES "
     "((SELECT id FROM merchants ORDER BY id LIMIT 1), 'verified'); "
     "SET LOCAL session_replication_role = replica; "
     "UPDATE trust_signals SET merchant_id = gen_random_uuid() WHERE id = "
     "(SELECT id FROM trust_signals ORDER BY id LIMIT 1);"),
]

# Batch D125 (continued): the other 38 empty-child names. The ten above were written out one by one to
# find the shape; these 38 are that one shape, so it is stated once as a function and an arm differs
# from its neighbour only in the row it inserts and the column it dangles.
# `_MUST` is the census: every column the schema forces an INSERT to carry (NOT NULL, no default), read
# off pg_attribute for the kept database, not guessed. A value that is a table name is filled with a
# live id from it, and four parents are themselves empty at seed -- carts, conversations, orders and
# payments -- so the chain rows are inserted first in the same session with checks still ON, which is
# what makes the whole row legal rather than merely tolerated. payments is a chain row nobody asked
# for: the pre-flight refused `refunds` because payments is empty, and the sweep never names payments
# at all, because its one FK points at orders, which is outside quality.sql's 23-table anchor. The
# dangle itself is the D123 mechanism unchanged.
_NOUN = {
    "campaigns": "a campaign", "cart_items": "a cart line", "carts": "a cart",
    "conversations": "a conversation", "coupons": "a coupon",
    "external_principals": "an external principal", "feedback_events": "a feedback event",
    "handoffs": "a handoff", "notifications": "a notification", "order_items": "an order line",
    "orders": "an order", "recommendation_sets": "a recommendation set", "referrals": "a referral",
    "refunds": "a refund", "reservations": "a reservation", "seo_pages": "an SEO page",
}

_MUST = {
    "campaigns": {"merchant_id": ("ref", "merchants"), "title": "'plant campaign'"},
    "cart_items": {"cart_id": ("chain", "carts"), "unit_price": "12.00"},
    "carts": {"tenant_id": ("ref", "tenants")},
    "conversations": {"tenant_id": ("ref", "tenants")},
    "coupons": {"tenant_id": ("ref", "tenants"), "code": "'PLANT-D125'", "value": "12.00",
                "starts_at": "now() - interval '1 day'", "ends_at": "now() + interval '1 day'"},
    "external_principals": {"protocol": "'a2a'", "client_id": "'plant-client'",
                            "name": "'plant principal'"},
    "feedback_events": {"subject_type": "'merchant'", "subject_id": ("ref", "merchants"),
                        "signal": "'up'"},
    "handoffs": {"conversation_id": ("chain", "conversations"), "merchant_id": ("ref", "merchants"),
                 "reason": "'plant handoff'"},
    "notifications": {"audience": "'merchant'", "template": "'plant notification'"},
    "order_items": {"order_id": ("chain", "orders"), "name_snapshot": "'plant item'",
                    "unit_price": "12.00", "total_price": "12.00"},
    "orders": {"code": "'PLANT-D125'", "merchant_id": ("ref", "merchants"),
               "tenant_id": ("ref", "tenants")},
    "payments": {"amount": "12.00", "idempotency_key": "'plant-d125'", "order_id": ("chain", "orders")},
    "recommendation_sets": {"tenant_id": ("ref", "tenants")},
    "referrals": {"kind": "'invite'", "referrer_type": "'user'", "referrer_id": ("ref", "users"),
                  "code": "'PLANT-D125'"},
    "refunds": {"amount": "12.00", "payment_id": ("chain", "payments")},
    "reservations": {"code": "'PLANT-D125'", "merchant_id": ("ref", "merchants"),
                     "tenant_id": ("ref", "tenants"), "starts_at": "now() + interval '7 days'"},
    "seo_pages": {"kind": "'category'", "path": "'/plant/d125'", "tenant_id": ("ref", "tenants")},
}

# (child, the FK column the sweep names, its parent) -- the 38 names quality.sql assembles for a child
# table the seed leaves empty, minus share_links' two, which exist only on an uncommitted migration.
_EMPTY_CHILD_FKS = [
    ("campaigns", "approved_by", "users"), ("campaigns", "merchant_id", "merchants"),
    ("campaigns", "tenant_id", "tenants"), ("cart_items", "offering_id", "offerings"),
    ("carts", "merchant_id", "merchants"), ("carts", "tenant_id", "tenants"),
    ("carts", "user_id", "users"), ("conversations", "merchant_id", "merchants"),
    ("conversations", "tenant_id", "tenants"), ("conversations", "user_id", "users"),
    ("coupons", "created_by", "users"), ("coupons", "merchant_id", "merchants"),
    ("coupons", "published_by", "users"), ("coupons", "tenant_id", "tenants"),
    ("external_principals", "linked_user_id", "users"),
    ("external_principals", "merchant_id", "merchants"),
    ("feedback_events", "tenant_id", "tenants"), ("feedback_events", "user_id", "users"),
    ("handoffs", "merchant_id", "merchants"), ("notifications", "merchant_id", "merchants"),
    ("notifications", "tenant_id", "tenants"), ("notifications", "user_id", "users"),
    ("order_items", "offering_id", "offerings"), ("orders", "merchant_id", "merchants"),
    ("orders", "tenant_id", "tenants"), ("orders", "user_id", "users"),
    ("recommendation_sets", "tenant_id", "tenants"), ("recommendation_sets", "user_id", "users"),
    ("referrals", "invitee_id", "users"), ("referrals", "tenant_id", "tenants"),
    ("refunds", "approved_by", "users"), ("reservations", "merchant_id", "merchants"),
    ("reservations", "offering_id", "offerings"), ("reservations", "slot_id", "availability_slots"),
    ("reservations", "tenant_id", "tenants"), ("reservations", "user_id", "users"),
    ("seo_pages", "reviewed_by", "users"), ("seo_pages", "tenant_id", "tenants"),
]


def _insert(table, extra=None):
    """A legal INSERT: the columns the schema demands, plus the column the arm will dangle."""
    must = dict(_MUST.get(table, {}))
    for col, value in (extra or {}).items():
        must.setdefault(col, value)
    cols, vals = [], []
    for col in sorted(must):
        value = must[col]
        cols.append(col)
        vals.append("(SELECT id FROM %s ORDER BY id LIMIT 1)" % value[1]
                    if isinstance(value, tuple) else value)
    return "INSERT INTO %s (%s) VALUES (%s)" % (table, ", ".join(cols), ", ".join(vals))


def _inserts_for(table, extra=None, seen=()):
    """The table's legal INSERT, preceded by every empty table it has to reference first."""
    if table in seen:
        return []
    out = []
    for dep in [v[1] for k, v in sorted(_MUST.get(table, {}).items())
                if isinstance(v, tuple) and v[0] == "chain"]:
        out += _inserts_for(dep, None, seen + (table,))
    return out + [_insert(table, extra)]


def _traffic_arm(child, col, parent):
    plant = _inserts_for(child, {col: ("ref", parent)}) + [
        "SET LOCAL session_replication_role = replica",
        "UPDATE %s SET %s = gen_random_uuid() WHERE id = "
        "(SELECT id FROM %s ORDER BY id LIMIT 1)" % (child, col, child)]
    return ("fk: %s.%s -> %s.id" % (child, col, parent),
            "synthetic traffic row (%s): the written row's %s is a ghost id (0 rows in the table at seed)"
            % (_NOUN[child], col),
            "; ".join(plant) + ";")


ARMS += [_traffic_arm(c, col, p) for c, col, p in _EMPTY_CHILD_FKS]

# Batch D126: arms the schema ACCEPTS. Every arm above switches `session_replication_role` to `replica`
# somewhere in its plant, and after D125 that mechanism carries 101 of the 171 witnessed names -- so what
# this lane had never shown is an assertion reddened by a write the database itself lets through. These 12
# are single statements, constraint checks ON, no role switch, no ghost id: a portfolio moved to another
# merchant, a queued review published, a TTL written wrong, a provenance timestamp nulled, an invented
# subject type inserted. Each was checked for legality against pg_constraint first -- moderation_cases and
# permission_grants carry no CHECK at all, availability_slots bounds only its times and capacity, so
# `source = 'live'` is a value the schema never hears of. Two census rows had to be dropped before aiming:
# no merchant has exactly one offering and none has exactly one category link, so the row-moving arms move
# WHOLE portfolios (`WHERE merchant_id = …`, one statement, many rows) rather than one row each.
ARMS += [
    ("merchant has >=1 offering",
     "a legal write the schema accepts: one merchant's whole portfolio moved to another",
     "UPDATE offerings SET merchant_id = (SELECT id FROM merchants ORDER BY id DESC LIMIT 1) "
     "WHERE merchant_id = (SELECT id FROM merchants ORDER BY id LIMIT 1);"),
    ("merchant has a location",
     "a legal write the schema accepts: a one-location merchant's primary location moved away",
     "UPDATE locations SET merchant_id = (SELECT id FROM merchants ORDER BY id DESC LIMIT 1) "
     "WHERE merchant_id = (SELECT merchant_id FROM locations WHERE is_primary GROUP BY 1 "
     "HAVING count(*) = 1 AND merchant_id <> (SELECT id FROM merchants ORDER BY id DESC LIMIT 1) "
     "ORDER BY 1 LIMIT 1);"),
    ("merchants map to >=1 leaf category",
     "a legal write the schema accepts: the least categorised merchant lost every category link",
     "UPDATE merchant_categories SET merchant_id = (SELECT id FROM merchants ORDER BY id DESC LIMIT 1) "
     "WHERE merchant_id = (SELECT merchant_id FROM merchant_categories GROUP BY 1 "
     "HAVING merchant_id <> (SELECT id FROM merchants ORDER BY id DESC LIMIT 1) "
     "ORDER BY count(*) ASC LIMIT 1);"),
    ("the queue has something in it (an empty inbox is not proof of a process)",
     "a legal write the schema accepts: every open review case closed in one statement",
     "UPDATE moderation_cases SET status = 'closed' WHERE subject_type = 'review' AND status = 'open';"),
    ("no case points at a review consumers can already read",
     "a legal write the schema accepts: a review still in the queue published to everyone",
     "UPDATE reviews SET status = 'published' WHERE id = "
     "(SELECT c.subject_id FROM moderation_cases c WHERE c.subject_type = 'review' AND c.status = 'open' "
     "ORDER BY c.id LIMIT 1);"),
    ("human grants carry no deadline",
     "a legal write the schema accepts: every human grant given an expiry date",
     "UPDATE permission_grants SET expires_at = now() + interval '30 days' "
     "WHERE subject_type = 'merchant_user';"),
    ("facts all carry expires_at (TTL per",
     "a legal write the schema accepts: one fact made timeless",
     "UPDATE facts SET expires_at = NULL WHERE id = (SELECT id FROM facts ORDER BY id LIMIT 1);"),
    ("hours facts respect the 24h TTL",
     "a legal write the schema accepts: one opening-hours fact given a 25-hour TTL",
     "UPDATE facts SET expires_at = observed_at + interval '25 hours' WHERE id = "
     "(SELECT id FROM facts WHERE attribute = 'opening_hours' ORDER BY id LIMIT 1);"),
    # Dropped while aiming, and the reason is the finding: `offerings.price_updated_at` is NOT NULL in the
    # schema, so no write -- legal or not -- can leave a priced offering without it, and
    # `session_replication_role = replica` does not silence NOT NULL either. The assertion is implied by
    # the column, which makes it the one kind of qc row no plant can falsify.
    ("chunks: embedding NULL and embed_model=pending",
     "a legal write the schema accepts: an unembedded chunk labelled as embedded",
     "UPDATE chunks SET embed_model = 'text-embedding-3-small' WHERE id = "
     "(SELECT id FROM chunks ORDER BY id LIMIT 1);"),
    ("slots marked source=demo (never real availability)",
     "a legal write the schema accepts: one slot marked as real availability",
     "UPDATE availability_slots SET source = 'live' WHERE id = "
     "(SELECT id FROM availability_slots ORDER BY id LIMIT 1);"),
    # Aimed at `no unlisted type rides in the seeded data` and re-aimed after the pre-flight: the invented
    # subject type slid straight past it, because that census only walks the pairs the arm registry arms,
    # and feedback_events is not one of them. The row that DID notice is the vocabulary row below, so this
    # legal INSERT now testifies for it -- D79's silence, arriving on the polymorphic plane: an unlisted
    # type on an unarmed pair is not unseen by every census, but it is unseen by the one that claims to
    # catch it.
    ("a seeded polymorphic vocabulary is bounded or probed",
     "a legal write the schema accepts: a feedback event filed under a subject type nobody declared",
     "INSERT INTO feedback_events (tenant_id, subject_type, subject_id, signal) VALUES "
     "((SELECT id FROM tenants ORDER BY id LIMIT 1), 'plant', "
     "(SELECT id FROM merchants ORDER BY id LIMIT 1), 'up');"),
]

# Batch D127: nine more legal writes, aimed at the demo-property rows D126 left on the 33. Same rule as
# D126 -- one statement, constraint checks ON, no role switch, no ghost id -- and each one is the shape
# the assertion actually claims to guard against: a rating distribution smoothed out, a price fact
# re-labelled from inferred to merchant, a document's provenance marker pointed at the real web, a
# collection card referencing a merchant id that is not in the table, a review stripped of its aspects
# or of its concrete wording, a favourite filed under a type the API cannot save, a bookable offering
# whose merchant has no active pool. Two rows in the census are jsonb-internal, so the deception has to
# be written INTO the payload -- an FK column cannot reach them and neither can a ghost uuid, because
# nothing in the schema claims those ids in the first place.
ARMS += [
    ("ratings realistically spread (not all 5.0)",
     "a legal write the schema accepts: every below-average merchant rating lifted to 4.5",
     "UPDATE merchants SET rating_agg = 4.5 WHERE rating_agg < 3.8;"),
    ("an estimated price is facted as inferred, not as merchant",
     "a legal write the schema accepts: an estimated price's fact re-labelled as the merchant's own claim",
     "UPDATE facts SET source = 'merchant' WHERE id = (SELECT f.id FROM facts f "
     "JOIN offerings o ON o.id = f.subject_id WHERE f.subject_type = 'offering' "
     "AND f.attribute = 'price' AND o.price_source = 'estimated' ORDER BY f.id LIMIT 1);"),
    ("jsonb data_origin marker (offerings/documents/chunks)",
     "a legal write the schema accepts: a document's provenance marker pointed at the real web",
     "UPDATE documents SET metadata = jsonb_set(metadata, '{data_origin}', to_jsonb('real'::text)) "
     "WHERE id = (SELECT id FROM documents ORDER BY id LIMIT 1);"),
    # Dropped after the pre-flight: writing a ghost merchant id into a collection's items left BOTH the
    # target and every companion green -- the statement touched nothing the check reads. Measured in
    # §135's `measured` block, and reported rather than papered over: the row claims to guard
    # collection/guide item references, and this seed's items array does not carry the shape the write
    # assumed, so no `SET LOCAL`-free arm reaches it from that side.
    ("reviews carry aspect scores for weak-aspect demos",
     "a legal write the schema accepts: one review's aspect scores emptied",
     "UPDATE reviews SET aspects = '{}'::jsonb WHERE id = "
     "(SELECT id FROM reviews WHERE aspects <> '{}'::jsonb ORDER BY id LIMIT 1);"),
    ("reviews cite concrete aspects (§55 inputs)",
     "a legal write the schema accepts: every review rewritten to a bare opinion",
     "UPDATE reviews SET body = '食物不錯，下次再來。' WHERE body ~* "
     "'候位|等咗|排隊|quiet|噪音|嘈|份量|分量大|平貴|性價比|抵|MTR|港鐵|步行|分钟|分鐘|service|staff|slow|fast|clean|乾淨';"),
    ("favourite subject_type is one the API can save",
     "a legal write the schema accepts: a favourite filed under a type the API has never heard of",
     "UPDATE favorites SET subject_type = 'restaurant' WHERE id = "
     "(SELECT id FROM favorites ORDER BY id LIMIT 1);"),
    ("facts.source is a documented provenance (§2)",
     "a legal write the schema accepts: one fact sourced to an undeclared string",
     "UPDATE facts SET source = 'walked past and looked' WHERE id = "
     "(SELECT id FROM facts ORDER BY id LIMIT 1);"),
    ("bookable offerings resolve to a pool",
     "a legal write the schema accepts: an offering made bookable for a merchant with no active pool",
     "UPDATE offerings SET bookable = true WHERE id = (SELECT o.id FROM offerings o WHERE NOT o.bookable "
     "AND o.status = 'active' AND NOT EXISTS (SELECT 1 FROM resource_pools p "
     "WHERE p.merchant_id = o.merchant_id AND p.status = 'active') ORDER BY o.id LIMIT 1);"),
]

# Batch D129: D128 said nine of the last 23 rows were falsifiable from the data plane. Aiming at them --
# which means reading each census far enough to know what its list is built FROM -- reduced that nine to
# two, and the two arms below are the survivors. The seven that fell away are not plants, they are
# corrections to §137, and they are listed here so the next reader does not re-derive them:
#   * `a join-one-type waiver is only true while the table ships one type` -- the predicate is over
#     `ref_registry WHERE kind = 'join-one-type'`, and the file registers exactly one INSERT into that
#     table (quality.sql:1150-1176), whose kinds are 'probe' and 'not-a-reference'. No waiver of that
#     kind exists, so the row's own detail says so and the NOT EXISTS is vacuously true: nothing reddens
#     it, and writing one would mean editing the file under test.
#   * `the reference census reads the catalogue` (`count(*) FROM ref_cat >= 17`, :1178-1180) and
#     `the polymorphic-pair census reads the catalogue` (:1263) -- `ref_cat` gets one row per COLUMN
#     enumerated from pg_attribute (:1119-1141), independent of how many rows those columns carry. A
#     DELETE cannot shrink a column list; only a migration can.
#   * `the string census declares a reading for every type it catches` (:3104) is `str_type` (a hand list
#     of base types) against `pg_type` caught by the census -- a new column type, not a new value.
#   * `a census that folds case reports both readings and which one the demo exercises` (:3134) needs two
#     citext values differing only by case in one column, and the only citext columns are `users.email`
#     and its index `users_email_tenant_uniq` -- a unique index over a case-insensitive type forbids
#     exactly that pair, so the collision the row watches for is the one write the schema refuses.
#   * `a bounded string column is answered by name` (:3022) is reachable in principle (collapse a
#     many-distinct text column into the <=12-distinct window), but every candidate measured so far needs
#     a column inventory this lane has not taken -- left open rather than guessed at.
ARMS += [
    ("the elements of an object-array column all carry the same keys",
     "a legal write the schema accepts: one merchant's first image given a key none of the others carry",
     "UPDATE merchants SET images = jsonb_set(images, '{0,source}', to_jsonb('plant'::text)) "
     "WHERE id = (SELECT id FROM merchants ORDER BY id LIMIT 1);"),
    # The 3km ring is measured here as a bounding box because `pg_temp.haversine_m` exists only while
    # quality.sql is running, and the plant executes before the gate body -- the plant cannot call a
    # function the gate has not created yet. The destination stays inside the HK bbox so the row that
    # guards the bbox is not the one that goes red.
    ("density: >= ",
     "a legal write the schema accepts: every primary location inside the Sha Tin ring moved out of it",
     "UPDATE locations SET lat = 22.20, lng = 114.30 WHERE is_primary "
     "AND lat BETWEEN 22.3561 AND 22.4101 AND lng BETWEEN 114.1584 AND 114.2168;"),
]

# Batch D131: the last two rows D129 left as "worth a plant", aimed from a column inventory rather than
# from a guess. `a bounded string column is answered by name` counts string columns inside a window
# (<= 12 distinct, >= 20 rows, <= 1 value per 4 rows) and demands a named answer per column, so the arm
# collapses a column that sits just OUTSIDE that window -- `documents.title`, 1040 rows over 934
# distinct values, no CHECK and no unique index -- into 12 buckets, which is what a re-labelled corpus
# looks like. The second arm takes `a served view answers every column it exposes` at its own word: the
# exemption text at quality.sql:3318-3323 claims that seeding traffic puts `v_merchant_funnel.views` at
# two values over 520 rows, so this writes events for 260 merchants with the checks ON and asks whether
# the served-view row notices. That second arm was REMOVED at the pre-flight: `events` has no
# merchant_id column, so "seed events for 260 merchants" reaches the funnel by a route this file has not
# found, and the exemption's own claim (quality.sql:3318-3323) stays untested rather than guessed at.
# The collapse arm reddened its target with zero collateral -- 3 sessions, RESULT PASS.
ARMS += [
    ("a bounded string column is answered by name",
     "a legal write the schema accepts: 1040 document titles collapsed into twelve buckets",
     "UPDATE documents SET title = 'plant bucket ' || (abs(hashtext(title)) % 12);"),
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
        # Provenance travels with the row, not with the name: a collateral red that happens to name another
        # arm's target was still emitted from collateral, and a reader of this line must not be told otherwise.
        pairs = ([(n, label, "own") for n, label in witnessed]
                 + [(n, label, "collateral") for n, label in collateral_witnessed])
        pairs = [p for p in pairs if (p[0], p[1]) not in filed and p[0] not in base_reds]
        # A name has to be on the plane before anything can witness it. Some census rows assemble their names
        # from the VALUES they find -- the reference census files `orphan: <table>.<subject_type>` -- so a
        # plant can mint an assertion that exists only inside its own transaction and rolls away with it.
        # That happened twice with `orphan: favorites.restaurant`, and both times the registry reader
        # answered FAIL; deleting the row afterwards is not a fix, because the next drive mints it again
        # from the same arm. So the refusal lives here, and prints what it refused.
        off_plane = sorted({p[0] for p in pairs if p[0] not in base_names})
        pairs = [p for p in pairs if p[0] in base_names]
        seen, new = set(), []
        for p in pairs:
            if p[0] not in seen:
                seen.add(p[0])
                new.append(p)
        with Path(args.emit_rows).open("a", encoding="utf-8", newline="") as fh:
            for n, label, _ in new:
                fh.write(f"{n}\t{args.unit}\t{label}\t{args.witness}\n")
        novel = [p for p in new if p[0] not in {c for c, _ in filed}]
        print(f"registry rows appended: {len(new)} "
              f"({sum(1 for p in new if p[2] == 'own')} emitted from an arm's own RED row, "
              f"{sum(1 for p in new if p[2] == 'collateral')} from collateral) · "
              f"{len(novel)} of them name an assertion that carried no witness before"
              + (f" · refused {len(off_plane)} name(s) the unmutated gate does not file: "
                 + "; ".join(off_plane) if off_plane else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
