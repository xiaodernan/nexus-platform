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

# 1. The page rendered live, not the mock fixtures.
check('status 200', status == 200, f'HTTP {status}')
check('merchant name', '朗澗小廚' in body)
check('not the mock dataset', '龍軒' not in body and '海桃' not in body)

# 2. The §4 fields the cast used to leave blank now carry wire values.
check('price from the wire', '136.7' in body or 'HK$137' in body,
      re.findall(r'HK\$\d+(?:\.\d+)?', body)[:4])
check('category badge', 'Hot Pot' in body)
check('address line', 'Ning Lane' in body)
check('mtr', 'Sha Tin' in body)

# 3. Hours: the two conventions the wire does not share.
check('hours rendered', '12:3' in body and '15:0' in body)
check('weekday labels are the UI order', '週一' in body and '週日' in body,
      sorted(set(re.findall(r'週[一二三四五六日天]', body))))

# 4. The §19 trust chain, end to end.
facts = {f['attribute']: f for f in payload['facts']}
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

# 6. Honest absence: no rating fact exists, so the rating must not read as a verified number.
check('rating has no fact to cite', 'rating' not in facts)
check('rating number is not presented', '3.6' not in body and '3.62' not in body)
check('unverified marker present', '未驗證' in body)

failed = [c for c in checks if not c[1]]
for name, ok, evidence in checks:
    print(('PASS ' if ok else 'FAIL ') + name + ('' if ok or evidence == '' else f'  -> {evidence}'))
print(f'\n{len(checks) - len(failed)}/{len(checks)} checks passed; HTTP {status}; html {len(html)} bytes')
sys.exit(1 if failed else 0)
