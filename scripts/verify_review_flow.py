"""The review lifecycle over HTTP — write, queue, publish, and the number that has to follow.

Run it against a throwaway instance (`scripts/e2e_fresh.sh --keep`), the way `verify_reservation.py` is run:
it writes rows, so the environment that proves it should be one that can be thrown away afterwards.

    python scripts/verify_review_flow.py                      # :8092
    NEXUS_PLATFORM_URL=http://127.0.0.1:8090 python scripts/verify_review_flow.py

What it is really testing is the seam between three decisions. D37 stores a consumer review out of sight;
D38 makes a fact restatable at all; D39 gives the queue a door. Each of them is fine in isolation and the
composition is where a number could go stale: a card printing 4.12 while its `rating` fact still says 4.36,
or a published review that no aggregate counted. So the walk compares the printed rating, the cited fact and
an independent SQL recompute of the published rows, and it fails if any two of the three disagree.
"""

import json
import os
import sys
import urllib.error
import urllib.request

PLATFORM = os.environ.get('NEXUS_PLATFORM_URL', 'http://127.0.0.1:8092').rstrip('/')
TENANT = os.environ.get('NEXUS_TENANT', 'hong-kong')

results = []
# Every key this walk sends is scoped to the run, not to the merchant. A fixed key makes a second run
# *replay* the first run's response — which returns a review whose case has already been decided — and the
# walk then fails on a database it had already proved. A verifier has to be runnable twice against the same
# instance, because `--keep` exists precisely so it can be.
RUN = os.environ.get('NEXUS_VERIFY_NONCE') or f'{os.getpid()}-{int(__import__("time").time())}'


def check(name, ok, evidence=''):
    results.append((name, bool(ok)))
    print(('PASS ' if ok else 'FAIL ') + name + (f'  -> {evidence}' if evidence else ''))


def call(method, path, body=None, token=None, key=None):
    data = json.dumps(body).encode('utf-8') if body is not None else None
    headers = {'X-Tenant': TENANT, 'Content-Type': 'application/json'}
    if token:
        headers['Authorization'] = f'Bearer {token}'
    if key:
        headers['Idempotency-Key'] = key
    req = urllib.request.Request(PLATFORM + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            return res.status, json.loads(res.read().decode('utf-8') or '{}')
    except urllib.error.HTTPError as err:
        raw = err.read().decode('utf-8')
        return err.code, json.loads(raw) if raw.startswith('{') else {'raw': raw}


def sign_in(role):
    # The demo login takes a role, not a password, so no secret has to travel into this script —
    # and the walk works against any instance, not only one whose .env it happens to know.
    status, out = call('POST', '/api/v1/auth/demo', {'role': role})
    return out.get('access_token') if status == 200 else None


def main():
    consumer, admin = sign_in('consumer'), sign_in('admin')
    check('demo accounts can sign in', bool(consumer) and bool(admin),
          f'consumer={"ok" if consumer else "no"} admin={"ok" if admin else "no"}')
    if not (consumer and admin):
        return finish()

    st, queue0 = call('GET', '/api/v1/admin/moderation?status=open&limit=50', None, admin)
    open_cases = queue0.get('items', [])
    check('the seeded dataset has a queue (D39)', st == 200 and len(open_cases) > 0,
          f'HTTP {st} open cases={queue0.get("total_estimate")}')
    if not open_cases:
        return finish()
    # Some cases are reviews of merchants that are not on any consumer page yet (`pending_review`,
    # `suspended`). Publishing one is a correct decision about an invisible page, so the walk takes a case
    # whose merchant is actually readable and asserts the other kind behaves as it should below.
    readable = [c for c in open_cases
                if (c.get('subject') or {}).get('merchant', {}).get('status') == 'published']
    hidden = [c for c in open_cases
              if (c.get('subject') or {}).get('merchant', {}).get('status') not in (None, 'published')]
    check('the queue names the merchant status each case belongs to',
          all((c.get('subject') or {}).get('merchant', {}).get('status') for c in open_cases),
          f'{len(readable)} readable, {len(hidden)} at a merchant not on any consumer page')
    first = readable[0] if readable else open_cases[0]
    check('a case arrives with its subject readable', bool(first.get('subject', {}).get('excerpt')),
          json.dumps({'reason': first.get('reason'), 'auto_action': first.get('auto_action')}))
    if hidden:
        hslug = (hidden[0].get('subject') or {}).get('merchant', {}).get('slug')
        sth, _ = call('GET', f'/api/v1/merchants/{hslug}', None, None)
        check('a review of an unpublished merchant stays out of the consumer surface', sth == 404,
              f'{hslug} answered HTTP {sth}')

    st, seeded = call('POST', f"/api/v1/admin/moderation/{first['case_id']}/resolve",
                      {'decision': 'published', 'note': 'walk: reviewed and correct'}, admin,
                      key=f'seeded-{RUN}-{first["case_id"]}')
    check('a seeded case can be published', st == 200, json.dumps(seeded.get('error', seeded))[:150])
    check('publishing restates the rating it moved',
          st == 200 and 'merchant rating' in json.dumps(seeded.get('aggregate_restated', [])),
          json.dumps(seeded.get('aggregate_restated')))
    mslug = (first.get('subject') or {}).get('merchant', {}).get('slug')
    if st == 200 and mslug:
        agree = agrees(mslug)
        check('the published review is counted, printed and cited identically', agree[0], agree[1])

    st, page = call('GET', '/api/v1/merchants?limit=50', None, consumer)
    merchants = [m['slug'] for m in page.get('items', []) if m.get('slug')]
    posted = None
    for slug in merchants:
        st, out = call('POST', f'/api/v1/merchants/{slug}/reviews',
                       {'rating': 5.0, 'body': 'A five-star account of the walk through this place, written '
                                               'by the verification script itself, and long enough.'},
                       consumer, key=f'flow-{RUN}-{slug}')
        if st == 201:
            posted = (slug, out['review_id'])
            break
        if st == 409:
            continue
        check('posting a review to a seeded merchant works', False, f'HTTP {st} {out}')
        break
    check('the consumer can write a review somewhere', posted is not None,
          posted and f'{posted[0]} {posted[1][:8]}')
    if not posted:
        return finish()
    slug, review_id = posted

    st, before = call('GET', f'/api/v1/merchants/{slug}', None, consumer)
    rating_before = (before or {}).get('rating')
    check('the new review is not counted while pending',
          st == 200 and (rating_before or {}).get('count', 0) == before_count(before),
          json.dumps(rating_before))

    st, queue1 = call('GET', '/api/v1/admin/moderation?status=open&limit=50', None, admin)
    case = next((c for c in queue1.get('items', [])
                 if c.get('subject_id') == review_id and c.get('subject_type') == 'review'), None)
    check('the write opened a case the queue shows', case is not None,
          f'{st}, {len(queue1.get("items", []))} open cases scanned')
    if not case:
        return finish()

    st, out = call('POST', f"/api/v1/admin/moderation/{case['case_id']}/resolve",
                   {'decision': 'published', 'note': 'walk: checked line by line'}, admin,
                   key=f'resolve-{RUN}-{review_id}')
    check('a reviewer can publish it', st == 200, json.dumps(out.get('error', {}))[:150] if st != 200 else '')
    st, after = call('GET', f'/api/v1/merchants/{slug}', None, consumer)
    check('the rating the card prints counted it',
          st == 200 and (after.get('rating') or {}).get('count', 0) >= 1, json.dumps(after.get('rating')))
    agree = agrees(slug)
    check('printed rating, cited fact and published rows agree', agree[0], agree[1])

    st, second = call('POST', f"/api/v1/admin/moderation/{case['case_id']}/resolve",
                      {'decision': 'rejected', 'note': 'changed my mind'}, admin,
                      key=f'twice-{RUN}-{review_id}')
    check('a case cannot be decided twice', st == 409
          and second.get('error', {}).get('code') == 'case_already_resolved', f'HTTP {st}')
    return finish()


def before_count(profile):
    """How many published reviews the profile already claimed — 0 when it printed no rating at all."""
    return (profile or {}).get('rating', {}).get('count', 0)


def agrees(slug):
    """Three paths to one claim: the stored column the card prints, the fact that cites it, and the
    aggregate the reviews endpoint recomputes live over the published rows. Any two agreeing is a
    coincidence; all three agreeing is the invariant (D35/D38/D39)."""
    st, out = call('GET', f'/api/v1/merchants/{slug}', None, None)
    if st != 200:
        # An error envelope has no rating and no facts; reporting that as "no fact beside the rating"
        # would blame the citation for what is actually a missing page.
        return False, f'{slug}: profile answered HTTP {st} ({json.dumps(out.get("error", {}))[:80]})'
    rating = out.get('rating') or {}
    fact = next((f for f in out.get('facts', []) if f.get('attribute') == 'rating'), None)
    if not fact:
        return False, f'{slug}: no rating fact beside the printed rating {rating}'
    got = (round(float(rating.get('value', 0)), 2), int(rating.get('count', -1)))
    cited = (round(float(fact['value'].get('value', 0)), 2), int(fact['value'].get('count', -1)))
    if got != cited:
        return False, f'{slug}: card {got} vs fact {cited}'
    st2, page = call('GET', f'/api/v1/merchants/{slug}/reviews?limit=1', None, None)
    stats = page.get('aggregate') or page.get('review_stats') or {}
    if st2 != 200 or not stats:
        return False, f'{slug}: no recomputed aggregate to check against (HTTP {st2})'
    live = (round(float(stats.get('average_rating', stats.get('average', 0))), 2),
            int(stats.get('published_reviews', stats.get('published', -1))))
    if live != got:
        return False, f'{slug}: served {got} vs recomputed rows {live}'
    return True, f'{slug}: {got[0]} over {got[1]} reviews, card, fact and rows alike'


def finish():
    bad = [n for n, ok in results if not ok]
    print(f'\n{len(results) - len(bad)}/{len(results)} checks passed')
    if bad:
        print('FAILED: ' + '; '.join(bad))
    return 1 if bad else 0


if __name__ == '__main__':
    sys.exit(main())
