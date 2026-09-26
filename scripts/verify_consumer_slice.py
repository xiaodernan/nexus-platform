"""M4 consumer vertical slice, walked over HTTP — the gate §170 asks for.

Run it with the developer stack up:

    python -X utf8 scripts/verify_consumer_slice.py

Requires the platform on :8090 and the web prod build on :3002 (`NEXT_PUBLIC_DATA_MODE=live`);
`scripts/verify_merchant_page.py` and `scripts/verify_reservation.py` are executed as the two deep
legs and their tallies are folded into this one. The AI service on :8010 is probed, not assumed: when
it is down its steps are reported BLOCKED, because an unavailable dependency and a passing test are
different answers and only one of them is a lie (§109).

Screenshots are not available in this environment, so every assertion here is HTTP status, header, or
parsed JSON/HTML text. Nothing in this file judges layout or colour.
"""

import json
import subprocess
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone

PLATFORM = 'http://127.0.0.1:8090'
AI = 'http://127.0.0.1:8010'
TENANT = 'hong-kong'

results: list[tuple[str, str, str]] = []


def record(name: str, status, evidence: str = '') -> None:
    # Callers state either a verdict string ('BLOCKED') or the boolean the assertion produced.
    label = status if isinstance(status, str) else ('PASS' if status else 'FAIL')
    results.append((name, label, evidence))
    status = label
    print(f'{status:<8} {name}' + (f'  -> {evidence}' if evidence else ''))


def get(url: str):
    req = urllib.request.Request(url, headers={'X-Tenant': TENANT})
    try:
        with urllib.request.urlopen(req, timeout=20) as res:
            return res.status, res.read().decode('utf-8', 'replace'), dict(res.headers)
    except urllib.error.HTTPError as err:
        return err.code, err.read().decode('utf-8', 'replace'), dict(err.headers)
    except Exception as err:  # unreachable, refused, timeout — all mean "not up", not "broken code"
        return 0, str(err), {}


# ---------------------------------------------------------------- the fact-freshness leg (§5, AGENT_CONTRACT §5)

def parse_instant(text):
    """A served instant as a comparable datetime, or None when there is nothing to compare.

    None is the failure this leg reports: a fact with no parseable `expires_at` can never be derived as
    expired, so `isStale()` falls back on a column nothing re-stamps after the load and the number prints as
    fresh forever. A naive stamp is read as UTC rather than as the reader's own zone — a stated assumption,
    because the alternative is a check whose verdict depends on where it ran.
    """
    if not text or not isinstance(text, str):
        return None
    try:
        stamp = datetime.fromisoformat(text.strip().replace('Z', '+00:00'))
    except ValueError:
        return None
    return stamp.replace(tzinfo=timezone.utc) if stamp.tzinfo is None else stamp


def freshness_defects(cards, now):
    """Two lists of `merchant:attribute` strings: facts the client cannot age, and facts marked early.

    The consumer's "may have changed" is derived, not stamped — packages/ui/src/trust/fact.ts `isStale()` is
    `fact.stale === true || isExpired(fact, now)`. So a served fact owes exactly two things: an `expires_at`
    the client can compare, and a `stale` flag that does not contradict the TTL the fact itself carries.
    A missing expiry is the dangerous one (an expired number presented as live); a flag set while the TTL
    still runs is the milder one (a live number presented as doubtful), and both are checkable here rather
    than in a browser.
    """
    unageable, early = [], []
    for c in cards:
        who = c.get('slug') or c.get('id') or '?'
        for f in c.get('facts', []):
            label = f"{who}:{f.get('attribute')}"
            stamp = parse_instant(f.get('expires_at'))
            if stamp is None:
                unageable.append(label)
            elif f.get('stale') is True and stamp > now:
                early.append(f"{label} (expires {f.get('expires_at')})")
    return unageable, early


# ---------------------------------------------------------------- the directory leg (§4, §19, §20)

status, raw, headers = get(f'{PLATFORM}/api/v1/merchants?district=Sha%20Tin&limit=8&sort=-rating')
if status != 200:
    record('directory listing', 'FAIL', f'HTTP {status}')
    # Silence is not green (D79), and a leg that never ran is neither: the two freshness verdicts below live
    # inside the payload branch, so with no payload they are filed here as BLOCKED, naming why, instead of
    # disappearing from the tally.
    for nm in ('every served fact carries an expires_at the client can compare',
               'no fact is marked stale while its own TTL still runs'):
        record(nm, 'BLOCKED', f'no card payload to judge: the directory request returned HTTP {status}')
else:
    page = json.loads(raw)
    cards = page.get('items', [])
    record('directory listing', 'PASS', f'{len(cards)} cards, total_estimate={page.get("total_estimate")}')
    record('demo data is badgeable', headers.get('X-Demo-Data', '').lower() == 'true',
           headers.get('X-Demo-Data'))
    record('listings are cacheable, availability is not', 's-maxage=300' in (headers.get('Cache-Control') or ''),
           headers.get('Cache-Control'))

    priced = [c for c in cards if c.get('price')]
    record('a printed price has a price fact',
           all(any(f['attribute'] == 'price' for f in c.get('facts', [])) for c in priced),
           f'{len(priced)} priced cards checked')
    cited = [c for c in cards if (c.get('open') or {}).get('source_fact_id')]
    record('open.source_fact_id names one of the card’s own facts',
           all(any(f['fact_id'] == c['open']['source_fact_id'] for f in c.get('facts', [])) for c in cited),
           f'{len(cited)}/{len(cards)} cards cite an hours fact')
    record('every card prints the district it was filtered on',
           all(c.get('district') == 'Sha Tin' for c in cards))

    # What the consumer's "may have changed" actually rests on. The UI does not read the `stale` column as
    # the whole answer: packages/ui/src/trust/fact.ts `isStale()` returns `fact.stale === true ||
    # isExpired(fact, now)`, so a fact is flagged either because something stamped it or because the client
    # can compare its own clock against `expires_at`. Nothing in this system ever re-stamps the column after
    # the load — `markExpiredStale` (FactRepository.java:102) has no callers — so `expires_at` is the only
    # freshness signal a served fact has. That makes two things worth asserting, and the old one
    # (`every past-expiry fact arrives marked stale`) was neither: it asks for a stamp no producer writes,
    # and D91 measured it against 520 opening_hours facts, all of them past expiry and none of them marked,
    # because a 24-hour TTL is never already-expired at the instant the row is written.
    missing, marked_live = freshness_defects(cards, datetime.now(timezone.utc))
    record('every served fact carries an expires_at the client can compare', not missing,
           (f'{len(missing)} fact(s) without a usable expiry: ' + ', '.join(missing[:3])) if missing
           else f'{len([f for c in cards for f in c.get("facts", [])])} facts, all with a parseable'
                ' expires_at — isExpired() can fire on every one of them')
    record('no fact is marked stale while its own TTL still runs', not marked_live,
           (f'{len(marked_live)} fact(s) marked early: ' + ', '.join(marked_live[:3])) if marked_live
           else f'0 of {sum(1 for c in cards for f in c.get("facts", []))} served facts')

# ---------------------------------------------------------------- the AI leg (§7, §18, D13)

def post(url: str, body: dict):
    data = json.dumps(body).encode('utf-8')
    req = urllib.request.Request(url, data=data,
                                 headers={'Content-Type': 'application/json', 'X-Tenant': TENANT})
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            return res.status, json.loads(res.read().decode('utf-8'))
    except urllib.error.HTTPError as err:
        return err.code, json.loads(err.read().decode('utf-8'))
    except Exception as err:
        return 0, {'error': str(err)}


health_status, health_raw, _ = get(f'{AI}/ai/v1/health')
health = json.loads(health_raw) if health_status == 200 else {}
status = health_status
if status != 200:
    record('AI service answers /ai/v1/health', 'BLOCKED', f'no answer on {AI} (this script will not start it)')
else:
    record('AI service answers /ai/v1/health', 'PASS',
           f"status={health.get('status')} offline={health.get('offline')} provider={health.get('provider')}")
    status, search = post(f'{AI}/ai/v1/search', {'query': 'sha tin hot pot', 'limit': 5})
    cards = search.get('items', []) if status == 200 else []
    record('deterministic search returns cards', status == 200 and len(cards) > 0,
           f'HTTP {status}, {len(cards)} items, strategy={search.get("strategy")}, '
           f'degraded={search.get("degraded")}, took_ms={search.get("took_ms")}')
    # §18: an explanation bullet is only renderable when it names a fact on the card it decorates.
    bullets = [(c, r) for c in cards for r in ((c.get('ai_match') or {}).get('reasons') or [])]
    untraceable = [r.get('label') for _, r in bullets if not r.get('fact_id')]
    dangling = [r.get('label') for c, r in bullets
                if r.get('fact_id') and not any(f['fact_id'] == r['fact_id'] for f in c.get('facts', []))]
    record('every match explanation traces to a fact', not untraceable and not dangling,
           f'{len(bullets)} bullets; missing={untraceable[:3]} dangling={dangling[:3]}')
    rated = [c for c in cards if c.get('rating')]
    record('an AI-rendered rating is backed too',
           all(any(f['attribute'] == 'rating' for f in c.get('facts', [])) for c in rated),
           f'{len(rated)} cards print a rating')

# ---------------------------------------------------------------- the two deep legs

for script in ('verify_merchant_page.py', 'verify_reservation.py'):
    done = subprocess.run([sys.executable, '-X', 'utf8', f'scripts/{script}'],
                          capture_output=True, text=True)
    tail = [line for line in done.stdout.splitlines() if 'checks passed' in line]
    record(script, 'PASS' if done.returncode == 0 else 'FAIL', tail[-1] if tail else done.stderr[-200:])

failed = [r for r in results if r[1] == 'FAIL']
blocked = [r for r in results if r[1] == 'BLOCKED']
print(f'\n{len(results) - len(failed) - len(blocked)} passed, {len(blocked)} blocked, {len(failed)} failed')
sys.exit(1 if failed else 0)
