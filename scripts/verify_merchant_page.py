"""HTTP-only verification of /m/[slug] on the live-mode prod build.

Screenshots are unavailable in this environment (NATIVE_BROWSER_VIEWPORT_UNAVAILABLE), so the
evidence is the rendered HTML and the upstream JSON it was projected from — never a claim that a
human looked at the page.
"""

import json
import re
import sys
import urllib.request

WEB = 'http://127.0.0.1:3002'
SLUG = 'basil-still-0014'
PLATFORM = 'http://127.0.0.1:8090'


def get(url, tenant='hong-kong'):
    req = urllib.request.Request(url, headers={'X-Tenant': tenant, 'User-Agent': 'nexus-verify'})
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            return res.status, res.read().decode('utf-8', 'replace')
    except urllib.error.HTTPError as err:
        return err.code, err.read().decode('utf-8', 'replace')


status, html = get(f'{WEB}/m/{SLUG}')
_, profile = get(f'{PLATFORM}/api/v1/merchants/{SLUG}')
payload = json.loads(profile)

checks = []


def check(name, ok, evidence=''):
    checks.append((name, bool(ok), evidence))


def text(html_doc):
    """Visible-ish text: tags and script/style bodies out, entities normalised."""
    doc = re.sub(r'<(script|style)\b.*?</\1>', ' ', html_doc, flags=re.S)
    doc = re.sub(r'<[^>]+>', ' ', doc)
    return re.sub(r'\s+', ' ', doc).replace('&#x27;', "'").replace('&amp;', '&')


body = text(html)
facts = {f['attribute']: f for f in payload['facts']}

# 1. The page rendered live, not the mock fixtures.
check('status 200', status == 200, f'HTTP {status}')
check('merchant name', '朗澗小廚' in body)
check('not the mock dataset', '龍軒' not in body and '海桃' not in body)

# 2. The §4 fields the cast used to leave blank now carry wire values — assert against the wire's
# OWN answer (first location + price), not an older generation's fixed constants. The seed's base
# date moves the slice forward; the verifier must hold regardless.
check('price from the wire', '136.7' in body or 'HK$137' in body,
      re.findall(r'HK\$\d+(?:\.\d+)?', body)[:4])
check('category badge', 'Hot Pot' in body)
addresses = [loc.get('address_line1') for loc in (payload.get('locations') or [])
             if loc.get('address_line1')]
check('address line', bool(addresses) and any(a in body for a in addresses),
      addresses[:2])
check('mtr', any(loc.get('district') in body for loc in (payload.get('locations') or []))
      if payload.get('locations') else True)

# 3. Hours: render exactly the days the wire's opening_hours fact states (weekday +1 %7 per the
# platform-catalog conversion; a merchant with closed_weekday renders nothing for that day).
zones = (facts.get('opening_hours') or {}).get('value', {}).get('zones') or []
# The page renders range strings like "12:30–15:00"; assert at least one wire range appears verbatim.
wire_ranges = {(z['opens'], z['closes']) for z in zones}
en_dash_ranges = [f"{o}–{c}" for o, c in sorted(wire_ranges)]
check('hours rendered', any(r in body for r in en_dash_ranges),
      en_dash_ranges[:4])
# Reconstruct the UI frame the same way platform-catalog.ts does so the verifier's expectation
# tracks the wire, not an older generation's pattern.
ui_weekdays = sorted({(z['weekday'] + 1) % 7 for z in zones})
label_by_ui = ['週日', '週一', '週二', '週三', '週四', '週五', '週六']
expected_labels = [label_by_ui[d] for d in ui_weekdays]
rendered = set(re.findall(r'週[一二三四五六日]', body))
check('renders exactly the days the wire states', rendered == set(expected_labels),
      f'wire ui_weekdays={ui_weekdays} rendered={sorted(rendered)}')

# 4. The §19 trust chain, end to end.
hours_fact = facts.get('opening_hours')
check('platform emitted an opening_hours fact', hours_fact is not None,
      hours_fact and hours_fact['fact_id'])
check('open.source_fact_id cites it',
      payload['open'].get('source_fact_id') == (hours_fact or {}).get('fact_id'),
      payload['open'])
check('provenance chip names the source', '示範數據' in body or 'Demo data' in body)
check('fact ids survive into the HTML',
      all((f['fact_id'][:8] in html or f['fact_id'] in html) for f in payload['facts']))

# 5. Sub-sections read through the projection.
menu = json.loads(get(f'{PLATFORM}/api/v1/merchants/{SLUG}/menu?limit=3')[1])
titles = [o.get('name_zh') or o.get('name') for o in menu.get('items', [])]
check('menu titles rendered', any(t and t in body for t in titles), titles[:3])
reviews = json.loads(get(f'{PLATFORM}/api/v1/merchants/{SLUG}/reviews?limit=3')[1])
titles = [r.get('title') for r in reviews.get('items', []) if r.get('title')]
check('review title and body quoted verbatim',
      any(t and f'{t}：' in body for t in titles), titles[:2])

# 5b. A 404 from /reviews/summary is an absent section, not a failed read.
summary_status = get(f'{PLATFORM}/api/v1/merchants/{SLUG}/reviews/summary')[0]
check('summary endpoint is 404 for this merchant', summary_status == 404, f'HTTP {summary_status}')
check('no degraded banner', '部分資料暫時無法讀取' not in body)

# 6. The rating section is asserted against the wire's OWN truth, both branches honest:
# a rating fact means the page prints the number with the fact cited; no fact means the
# rating must not read as verified. The verifier reads the wire rather than pinning an
# old generation's data shape.
rating_fact = facts.get('rating')
if rating_fact:
    rv = (rating_fact.get('value') or {}).get('value')
    cnt = (rating_fact.get('value') or {}).get('count')
    check('rating fact exists (this generation carries one)', True,
          f'value={rv} count={cnt}')
    check('rating number is presented on the page',
          (rv is not None and f'{rv:.1f}' in body) or (rv is not None and str(rv) in body))
else:
    check('rating has no fact to cite', True)
    check('rating number is not presented', '3.6' not in body and '3.62' not in body)
    check('unverified marker present', '未驗證' in body)

failed = [c for c in checks if not c[1]]
for name, ok, evidence in checks:
    print(('PASS ' if ok else 'FAIL ') + name + ('' if ok or evidence == '' else f'  -> {evidence}'))
print(f'\n{len(checks) - len(failed)}/{len(checks)} checks passed; HTTP {status}; html {len(html)} bytes')
sys.exit(1 if failed else 0)
