"""Live walk of the reservation write path on :8090 — the terminal step of the consumer slice (§40).

Runs against the developer database with the demo login, books one real seeded slot, reads it back, then
walks the merchant's side: the §23 booking inbox must show the hold the consumer just made, and the
cancel leg must give the seats back exactly once. It writes rows; that is the point, and every id it
created is printed so the same command can be audited afterwards.
"""

import base64
import json
import sys
import urllib.error
import urllib.request

PLATFORM = 'http://127.0.0.1:8090'
TENANT = 'hong-kong'


def call(method, path, body=None, token=None):
    data = json.dumps(body).encode('utf-8') if body is not None else None
    headers = {'X-Tenant': TENANT, 'Content-Type': 'application/json'}
    if token:
        headers['Authorization'] = f'Bearer {token}'
    req = urllib.request.Request(PLATFORM + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            return res.status, json.loads(res.read().decode('utf-8'))
    except urllib.error.HTTPError as err:
        raw = err.read().decode('utf-8')
        return err.code, json.loads(raw) if raw.startswith('{') else {'raw': raw}


results = []


def check(name, ok, evidence=''):
    results.append((name, bool(ok), evidence))
    print(('PASS ' if ok else 'FAIL ') + name + (f'  -> {evidence}' if evidence != '' else ''))


status, demo = call('POST', '/api/v1/auth/demo', {'role': 'consumer'})
token = demo.get('access_token')
check('demo consumer login', status == 200 and bool(token), f'HTTP {status}')

status, page = call('GET', '/api/v1/merchants?district=Sha%20Tin&limit=20')
merchant = next((c for c in page.get('items', []) if c.get('id')), None)
check('directory listing', status == 200 and merchant is not None, merchant and merchant['slug'])

mid = merchant['id']
status, avail = call('GET', f'/api/v1/merchants/{mid}/availability?party_size=2')
slot = next((s for s in avail.get('slots', []) if (s.get('capacity_left') or 0) >= 2), None)
check('a slot with room for two', status == 200 and slot is not None,
      slot and f"{slot['id'][:8]} left={slot['capacity_left']} {slot['starts_at']}")

before = slot['capacity_left']
body = {'merchant_id': mid, 'slot_id': slot['id'], 'party_size': 2,
        'contact': {'name': 'Verify Run', 'phone': '2345 6789'}, 'notes': 'HTTP walk'}
status, created = call('POST', '/api/v1/reservations', body, token)
booked_status = status
code = created.get('code')
# 201 for a new hold, 200 when this slot was already booked by an earlier run of the same walk.
check('created or replayed with a code', status in (200, 201) and bool(code), f'HTTP {status} {code}')
check('status stays pending', created.get('status') == 'pending', created.get('status'))
slot_price = (slot.get('price') or {}).get('amount')
res_price = (created.get('price') or {}).get('amount')
check('price is the slot’s, or honestly absent', slot_price == res_price,
      f'slot={slot_price} reservation={res_price}')
check('terms came from the slot', created.get('starts_at') == slot['starts_at'], created.get('starts_at'))

status, replay = call('POST', '/api/v1/reservations', body, token)
check('replay is 200 with the same code', status == 200 and replay.get('code') == code, f'HTTP {status}')

status, mine = call('GET', '/api/v1/me/reservations', None, token)
check('reads back as mine', status == 200 and any(r.get('code') == code for r in mine), f'{len(mine)} rows')

status, after = call('GET', f'/api/v1/merchants/{mid}/availability?party_size=2')
held = next((s for s in after.get('slots', []) if s['id'] == slot['id']), None)
expected_left = before - 2 if booked_status == 201 else before
check('capacity moved once, not twice', held is not None and held['capacity_left'] == expected_left,
      held and f'{before} -> {held["capacity_left"]} (expected {expected_left})')

status, anon = call('POST', '/api/v1/reservations', body)
check('anonymous is 401', status == 401, f'HTTP {status} {anon.get("error", {}).get("code")}')

status, other = call('POST', '/api/v1/reservations',
                     {'merchant_id': mid, 'slot_id': slot['id'], 'party_size': 20,
                      'contact': {'phone': '2345 6789'}}, token)
check('party of 20 is refused', status in (409, 422), f'HTTP {status}')

# ------------------------------------------------------- the merchant's side (§23 booking inbox)

status, demo_m = call('POST', '/api/v1/auth/demo', {'role': 'merchant'})
mtoken = demo_m.get('access_token')
check('demo merchant login', status == 200 and bool(mtoken), f'HTTP {status}')

# Which business does that session own? There is no "list my merchants" route (a §23 gap in its own
# right), so the workspace id is read out of the access token the service itself issued — claim `mer`.
claims = json.loads(base64.urlsafe_b64decode(mtoken.split('.')[1] + '==='))
own = claims.get('mer')
check('token names the caller’s workspace', bool(own), str(own))

status, avail = call('GET', f'/api/v1/merchants/{own}/availability?party_size=2')
# Prefer a slot this walk has not already claimed. One live hold per person per slot is a database rule
# (V2), so re-booking the leg-1 slot comes back as a 200 replay of that earlier row — which is honest,
# but then the inbox leg would be checking a booking it never made.
slots = [s for s in avail.get('slots', []) if (s.get('capacity_left') or 0) >= 2]
own_slot = next((s for s in slots if s['id'] != (slot or {}).get('id')), slots[0] if slots else None)
check('the demo merchant has a bookable slot', own_slot is not None,
      own_slot and f"{own_slot['id'][:8]} {own_slot['starts_at']}"
      + ('' if own_slot is None or own_slot['id'] != (slot or {}).get('id') else ' (reused leg-1 slot)'))

held_code = None
if own_slot is None:
    check('inbox leg needs a slot', False, f'HTTP {status} {json.dumps(avail)[:120]}')
else:
    body2 = {'merchant_id': own, 'slot_id': own_slot['id'], 'party_size': 2,
             'contact': {'name': 'Inbox Walk', 'phone': '9876 5432'}, 'notes': 'inbox leg'}
    status, held = call('POST', '/api/v1/reservations', body2, token)
    held_code = held.get('code')
    booked_new = status == 201
    check('consumer booked into it', status in (200, 201) and bool(held_code), f'HTTP {status} {held_code}')

    status, inbox = call('GET', f'/api/v1/merchant/reservations?merchant_id={own}', None, mtoken)
    rows = inbox.get('items', [])
    row = next((r for r in rows if r.get('code') == held_code), None)
    check('the booking appears in the inbox', status == 200 and row is not None,
          f'HTTP {status}, {len(rows)} row(s)')
    if row is None:
        check('inbox leg needs the row it just wrote', False, json.dumps(inbox)[:160])
    else:
        # Compared against the booking response, not against the literal this script typed: a replay of
        # an earlier hold returns that hold's contact, and the property under test is that the merchant
        # sees the same booking the consumer was answered with.
        check('inbox shows the contact the merchant needs',
              row.get('contact') == held.get('contact') and bool(row.get('contact')),
              json.dumps(row.get('contact'), ensure_ascii=False))
        check('inbox does not hand out the holder’s user id',
              'user_id' not in row and (claims.get('sub') or '') not in json.dumps(row))
        check('terms are the slot’s own', row.get('starts_at') == own_slot['starts_at']
              and row.get('party_size') == 2, f"{row.get('starts_at')} party={row.get('party_size')}")
        # A slot the merchant never priced reads as null, not as 0.00 — 'free' and 'not stated' differ.
        check('price matches the slot exactly', row.get('price') == own_slot.get('price'),
              f"slot={json.dumps(own_slot.get('price'))} inbox={json.dumps(row.get('price'))}")
        check('a held booking is pending, not confirmed', row.get('status') == 'pending', row.get('status'))
        check('the route says it cannot confirm',
              'never' in json.dumps(inbox.get('definitions', {})),
              json.dumps(inbox.get('definitions', {}).get('confirmed')))

        status, filtered = call('GET', f'/api/v1/merchant/reservations?merchant_id={own}&status=confirmed',
                                None, mtoken)
        check('status filter excludes the pending hold',
              status == 200 and all(r.get('code') != held_code for r in filtered.get('items', [])),
              f'HTTP {status}, {len(filtered.get("items", []))} row(s)')
        status, bad = call('GET', f'/api/v1/merchant/reservations?merchant_id={own}&status=maybe',
                           None, mtoken)
        check('an unknown status is refused, not an empty page',
              status == 422 and bad.get('error', {}).get('code') == 'validation_error',
              f'HTTP {status} {json.dumps(bad.get("error", {}))[:80]}')

        # ---------------------------------------------------- release the hold (§40 cancel leg)
        rid = held.get('id') or row.get('reservation_id')
        status, cancelled = call('PATCH', f'/api/v1/reservations/{rid}', {'status': 'cancelled'}, token)
        check('the holder can release it', status == 200 and cancelled.get('status') == 'cancelled',
              f'HTTP {status} {cancelled.get("status")}')

        status, again = call('PATCH', f'/api/v1/reservations/{rid}', {'status': 'cancelled'}, token)
        check('a second cancel replays, it does not double-release',
              status == 200 and again.get('code') == held_code, f'HTTP {status}')

        # Seats read before this run already reflected an older hold when the booking was a replay, so
        # the expected end state depends on whether this walk claimed them.
        expected = own_slot['capacity_left'] + (0 if booked_new else 2)
        status, after2 = call('GET', f'/api/v1/merchants/{own}/availability?party_size=2')
        restored = next((s for s in after2.get('slots', []) if s['id'] == own_slot['id']), None)
        check('seats came back exactly once', restored is not None
              and restored['capacity_left'] == expected,
              restored and f"{own_slot['capacity_left']} -> {restored['capacity_left']} (expected {expected})")

        status, inbox2 = call('GET', f'/api/v1/merchant/reservations?merchant_id={own}', None, mtoken)
        row2 = next((r for r in inbox2.get('items', []) if r.get('code') == held_code), None)
        check('the merchant still sees the cancelled row, labelled',
              row2 is not None and row2.get('status') == 'cancelled', row2 and row2.get('status'))

print(f'\nreservation: {code}  slot: {slot["id"]}  merchant: {merchant["slug"]}')
print(f'inbox walk: {held_code} at merchant {own}')
print(f'{sum(1 for r in results if r[1])}/{len(results)} checks passed')
sys.exit(1 if any(not r[1] for r in results) else 0)
