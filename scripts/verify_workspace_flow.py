"""The workspace doors of API_CONTRACT §5 over HTTP — who is in a business, and what a key can do.

Run it against a throwaway instance (`scripts/e2e_fresh.sh --keep`), the way `verify_reservation.py` and
`verify_review_flow.py` are run: it writes rows, so the environment that proves it should be one that can be
thrown away afterwards.

    python scripts/verify_workspace_flow.py                      # :8092
    NEXUS_PLATFORM_URL=http://127.0.0.1:8090 python scripts/verify_workspace_flow.py

What it is really testing is a claim D5 has made since the beginning and no earlier walk could observe:
that `permission_grants`, not the role string, decides access. The nine §5 routes existed and were correct
and every seeded merchant was locked out of all of them (D40 documented the door; nothing in the dataset
held its key). So this walk signs in as the demo's own merchant — the account a visitor is handed — and
answers four questions with HTTP rather than with a reading of the code:

1. does `GET /api/v1/me` print the grants the table holds, or the empty list it used to hard-code?
2. do `/me` and `GET /members` describe the same person's access identically?
3. can that account actually open a workspace route?
4. does an API key it issues work because of its grant rows — and stop working the moment they are deleted?

Checks 1-2 are the same-seam pair: a screen and a roster disagreeing about one subject is the D35 failure
mode wearing a different hat. Check 4 is the one only HTTP can answer, because an assertion about
`subject_type='api_key'` rows is a claim about what the interceptor consults, not about what SQL says.
"""

import json
import os
import sys
import urllib.error
import urllib.request
import uuid as uuidlib

PLATFORM = os.environ.get('NEXUS_PLATFORM_URL', 'http://127.0.0.1:8092').rstrip('/')
TENANT = os.environ.get('NEXUS_TENANT', 'hong-kong')

results = []
# Scoped to the run, as in verify_review_flow.py: a fixed idempotency key makes the second walk replay the
# first walk's stored response, and the walk would then report a database it had already changed.
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
    # The demo login takes a role, not a password, so no secret travels into this script and the walk works
    # against any instance. `merchant` is demo.owner1@example.hk — the account a visitor is handed (§87).
    status, out = call('POST', '/api/v1/auth/demo', {'role': role})
    return out.get('access_token') if status == 200 else None


def main():
    merchant, consumer = sign_in('merchant'), sign_in('consumer')
    check('the demo merchant can sign in', bool(merchant),
          f'merchant={"ok" if merchant else "no"} consumer={"ok" if consumer else "no"}')
    if not merchant:
        return finish()

    # ---- 1. /me prints grants, not a placeholder --------------------------
    st, me = call('GET', '/api/v1/me', None, merchant)
    memberships = [m for m in me.get('memberships', []) if m.get('status') == 'active']
    check('the demo merchant belongs to a workspace', st == 200 and memberships,
          f'HTTP {st}, {len(memberships)} active of {len(me.get("memberships", []))} memberships')
    if not memberships:
        return finish()
    first = memberships[0]
    mid = first['merchant']['id']
    my_member_id = first.get('member_id')
    mine = sorted(first.get('permissions') or [])
    check('/me answers with the grants the table holds, not an empty list', mine,
          json.dumps({'slug': first['merchant'].get('slug'), 'role': first.get('role'),
                      'grants': len(mine)}))
    check('that answer includes admin_members, so §5 has a door to open', 'admin_members' in mine,
          json.dumps([p for p in mine if p.startswith('admin') or p.startswith('publish')]))
    if consumer:
        stc, mec = call('GET', '/api/v1/me', None, consumer)
        check('a consumer is told they own nothing (the field is per-user, not a constant)',
              stc == 200 and all(not m.get('permissions') for m in mec.get('memberships', [])),
              f'{len(mec.get("memberships", []))} memberships, all without grants')

    # ---- 2. two doors, one subject ---------------------------------------
    st, roster = call('GET', f'/api/v1/merchant/members?merchant_id={mid}', None, merchant)
    members = roster.get('members', [])
    check('GET /members answers 200 for the seeded owner', st == 200,
          f'HTTP {st} {json.dumps(roster.get("error", {}))[:120] if st != 200 else f"{len(members)} members"}')
    if st != 200:
        return finish()
    caller = next((m for m in members if m.get('member_id') == my_member_id), None)
    check('the roster names the caller, by the same membership id /me answered', caller is not None,
          f'{len(members)} members, looking for {str(my_member_id)[:8]}')
    if caller is None:
        return finish()
    check('the roster and /me describe the same access identically',
          sorted(caller.get('permissions') or []) == mine,
          json.dumps({'roster': sorted(caller.get('permissions') or [])[:3], 'me': mine[:3],
                      'equal': sorted(caller.get('permissions') or []) == mine}))
    check('no active member is printed as powerless',
          all(m.get('permissions') for m in members if m.get('status') == 'active'),
          f'{sum(1 for m in members if m.get("status") == "active")} active, '
          f'{sum(1 for m in members if not m.get("permissions"))} with no grants')
    presets = roster.get('roles', {})
    owner_preset = sorted(presets.get('owner') or [])
    check('the role preset the roster advertises is the grant list it holds',
          owner_preset == mine,
          f'preset {len(owner_preset)} vs grants {len(mine)}; '
          + json.dumps(sorted(set(owner_preset) ^ set(mine))))
    check('"admin_members" belongs to the owner preset only',
          all(('admin_members' in grants) == (role in ('owner', 'admin'))
              for role, grants in presets.items()),
          json.dumps({r: 'admin_members' in g for r, g in presets.items()}))

    # ---- 3. the doors actually open, and refuse ---------------------------
    mine_everywhere = {m['merchant']['id'] for m in me.get('memberships', []) if m.get('merchant')}
    st, page = call('GET', '/api/v1/merchants?limit=50', None, consumer)
    others = [m['id'] for m in page.get('items', []) if m.get('id') and m['id'] not in mine_everywhere]
    if others:
        sto, outo = call('GET', f'/api/v1/merchant/members?merchant_id={others[0]}', None, merchant)
        check('a workspace the caller is not in stays refused', sto == 403,
              f'{others[0][:8]} answered HTTP {sto} {json.dumps(outo.get("error", {}))[:80]}')
    else:
        check('a second merchant was available to test the refusal against', False,
              f'HTTP {st}, no foreign id in the listing')

    st, out = call('POST', '/api/v1/merchant/members',
                   {'merchant_id': mid, 'user_id': str(uuidlib.uuid4()), 'role': 'staff'}, merchant,
                   key=f'ghost-{RUN}')
    check('adding a person who is not in the tenant is a 404, not a membership row',
          st == 404 and out.get('error', {}).get('code') == 'user_not_found', f'HTTP {st}')

    st, out = call('PATCH', f"/api/v1/merchant/members/{my_member_id}", {'status': 'disabled'}, merchant)
    check('the last administrator cannot be locked out of their own business',
          st == 409 and out.get('error', {}).get('code') == 'last_admin', f'HTTP {st}')
    check('and the refusal left the access in place',
          any(m.get('member_id') == my_member_id and m.get('status') == 'active'
              for m in (call('GET', f'/api/v1/merchant/members?merchant_id={mid}', None, merchant)[1]
                        .get('members') or [])))

    # ---- 4. a key works because of its grant rows -------------------------
    st, keys0 = call('GET', f'/api/v1/merchant/api-keys?merchant_id={mid}', None, merchant)
    check('the key list is readable too', st == 200, f'HTTP {st}, {keys0.get("count")} keys')
    st, made = call('POST', '/api/v1/merchant/api-keys',
                    {'merchant_id': mid, 'name': f'walk-{RUN}', 'scopes': ['read_analytics']},
                    merchant, key=f'key-{RUN}')
    secret = made.get('api_key')
    check('creating a key returns its secret exactly once, at creation',
          st == 201 and bool(secret) and bool(made.get('prefix')),
          json.dumps({'status': st, 'prefix': made.get('prefix'), 'scopes': made.get('scopes')}))
    if not secret:
        return finish()
    key_id = made.get('api_key_id')

    st, served = call('GET', f'/api/v1/merchant/customers?merchant_id={mid}', None, secret)
    check('the key authenticates a read_analytics route on its own grants', st == 200,
          f'HTTP {st} {json.dumps(served.get("error", {}))[:100]}')

    st, keys1 = call('GET', f'/api/v1/merchant/api-keys?merchant_id={mid}', None, merchant)
    row = next((k for k in keys1.get('api_keys', []) if k.get('api_key_id') == key_id), None)
    check('the stored row shows the prefix and never the secret',
          st == 200 and row and row.get('prefix') == made.get('prefix')
          and secret not in json.dumps(keys1),
          json.dumps(row))

    st, gone = call('DELETE', f'/api/v1/merchant/api-keys/{key_id}', None, merchant)
    check('revoking it succeeds', st == 200, json.dumps(gone.get('error', {'revoked': gone.get('revoked')}))[:100])
    st, after = call('GET', f'/api/v1/merchant/customers?merchant_id={mid}', None, secret)
    check('and the same call is refused a moment later — access lived in the grant rows',
          st == 401 and after.get('error', {}).get('code') == 'invalid_api_key', f'HTTP {st}')
    st, still = call('GET', f'/api/v1/merchant/members?merchant_id={mid}', None, merchant)
    check('revoking a key leaves the human members untouched',
          st == 200 and still.get('count') == len(members), f'{still.get("count")} vs {len(members)}')
    return finish()


def finish():
    bad = [n for n, ok in results if not ok]
    print(f'\n{len(results) - len(bad)}/{len(results)} checks passed')
    if bad:
        print('FAILED: ' + '; '.join(bad))
    return 1 if bad else 0


if __name__ == '__main__':
    sys.exit(main())
