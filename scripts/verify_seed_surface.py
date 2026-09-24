#!/usr/bin/env python3
"""Cross the seed -> platform -> *signed-in consumer* seam over HTTP.

`scripts/verify_served_reads.mjs` checks 525 public reads against the throwaway seeded database, and the Java
suite checks the authenticated doors against tenants it builds itself. Nothing joined the two: no automated run
had ever asked whether *the seeded demo account's own saved list* survives the trip from `data/seed` through the
API. That is the seam where D58's new `quality.sql` invariant lives, and where a favourites regression would
first be felt by a person.

It is deliberately narrow: what the API can answer without peeking at the database.

    scripts/verify_seed_surface.py --base http://127.0.0.1:8092 --tenant hong-kong

Exits non-zero on the first unmet expectation, and refuses to pass on an empty list.
"""

import argparse
import json
import re
import sys
import urllib.error
import urllib.request

UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")

checks = []
failures = []


def report(name, ok, detail):
    checks.append(name)
    if not ok:
        failures.append((name, detail))
    print("  %-58s %s  %s" % (name[:58], "ok  " if ok else "FAIL", detail))


def call(base, tenant, method, path, token=None, body=None):
    req = urllib.request.Request(base + path, method=method)
    req.add_header("X-Tenant", tenant)
    req.add_header("content-type", "application/json")
    if token:
        req.add_header("Authorization", "Bearer " + token)
    data = json.dumps(body).encode() if body is not None else None
    try:
        with urllib.request.urlopen(req, data, timeout=25) as r:
            raw = r.read().decode("utf-8", "replace")
            return r.status, (json.loads(raw) if raw.strip().startswith(("{", "[")) else raw)
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "replace")
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, raw


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://127.0.0.1:8090")
    ap.add_argument("--tenant", default="hong-kong")
    args = ap.parse_args()

    print("=== the seeded consumer's own surface, over HTTP ===")

    code, door = call(args.base, args.tenant, "POST", "/api/v1/me/favorites",
                      body={"subject_type": "merchant", "subject_id": "0" * 32})
    report("the favourites door is not public", code == 401, "HTTP %s" % code)

    code, session = call(args.base, args.tenant, "POST", "/api/v1/auth/demo",
                         body={"role": "consumer"})
    if code != 200 or not isinstance(session, dict) or "access_token" not in session:
        report("demo login as the seeded consumer", False, "HTTP %s %s" % (code, str(session)[:120]))
        return finish()
    token = session["access_token"]
    report("demo login as the seeded consumer", True, "user %s" % session.get("user", {}).get("id", "?")[:8])

    code, me = call(args.base, args.tenant, "GET", "/api/v1/me", token)
    report("GET /me answers for that account", code == 200 and isinstance(me, dict), "HTTP %s" % code)
    if isinstance(me, dict):
        report("  and names the seeded email", me.get("email") == "demo.consumer@example.hk",
               repr(me.get("email")))

    code, favs = call(args.base, args.tenant, "GET", "/api/v1/me/favorites", token)
    ok = code == 200 and isinstance(favs, list)
    report("GET /me/favorites answers a list", ok and len(favs) > 0,
           "HTTP %s, %d row(s)" % (code, len(favs) if ok else -1))
    if not ok or not favs:
        return finish()

    shapes = all(isinstance(f, dict) and f.get("subject_type") in ("merchant", "offering", "collection")
                 and UUID_RE.match(str(f.get("subject_id", ""))) and f.get("created_at")
                 for f in favs)
    report("  every row has subject_type, a uuid id and a date", shapes,
           "%d rows, types %s" % (len(favs), sorted({f.get("subject_type") for f in favs})))
    noted = sum(1 for f in favs if f.get("note"))
    report("  the seeded note text arrives, not a blank slate", noted > 0,
           "%d of %d carry a note" % (noted, len(favs)))

    # The dereferenceable part: what the public doors say about the subjects this user saved.
    code, listing = call(args.base, args.tenant, "GET", "/api/v1/collections?limit=100")
    by_id = {}
    if code == 200 and isinstance(listing, dict):
        by_id = {i.get("id"): i.get("slug") for i in listing.get("items", [])}
    saved_collections = [f for f in favs if f["subject_type"] == "collection"]
    for f in saved_collections:
        slug = by_id.get(f["subject_id"])
        c2, _ = call(args.base, args.tenant, "GET", "/api/v1/collections/%s" % (slug or f["subject_id"]))
        report("  a saved collection is listed and readable", bool(slug) and c2 == 200,
               "slug=%s HTTP %s" % (slug, c2))
    saved_merchants = [f for f in favs if f["subject_type"] == "merchant"]
    for f in saved_merchants[:4]:
        c3, body = call(args.base, args.tenant, "GET", "/api/v1/merchants/%s" % f["subject_id"])
        ok3 = c3 == 200 and isinstance(body, dict) and body.get("card_type") == "merchant"
        report("  a saved merchant opens on its public page", ok3,
               "HTTP %s slug=%s" % (c3, (body.get("slug") if isinstance(body, dict) else "?")))
    saved_offerings = [f for f in favs if f["subject_type"] == "offering"]
    report("  saved offerings at least exist as a non-empty class (their pages are per-merchant)",
           len(saved_offerings) > 0, "%d offering row(s)" % len(saved_offerings))

    code, empty = call(args.base, args.tenant, "GET", "/api/v1/me/saved-searches", token)
    report("GET /me/saved-searches answers honestly (seed stores none)",
           code == 200 and isinstance(empty, list) and len(empty) == 0, "HTTP %s %d row(s)" % (code, len(empty) if isinstance(empty, list) else -1))

    return finish()


def finish():
    print("")
    if failures:
        for name, detail in failures:
            print("  FAILED: %s (%s)" % (name, detail))
        print("\nRESULT: FAIL — %d of %d checks failed" % (len(failures), len(checks)))
        return 1
    print("RESULT: PASS — %d checks passed against the seeded signed-in surface" % len(checks))
    return 0


if __name__ == "__main__":
    sys.exit(main())
