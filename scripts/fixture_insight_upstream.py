#!/usr/bin/env python3
"""D887's fixture: ONE throwaway upstream that REGISTERS ITSELF with Eureka by application name.

D885's `insight_smoke.sh` proves the fallback half with Eureka disabled, and D886's
`insight_registry_smoke.sh` proves that nexus-insight itself joins the registry. Neither proves
that a declarative `@FeignClient(name = ...)` resolves `lb://NEXUS-PLATFORM` / `lb://NEXUS-AI`
to a LIVE instance and copies that instance's answer. This fixture closes exactly that gap.

Run it twice, once per application name, with a distinct port and health path each time. It is not
a real platform or AI service; it answers one health URL, and its `status` can be switched at
runtime through `/__control/status/<VALUE>` so the smoke can prove that PlaneController reports
the upstream's own value (including a non-UP one) rather than a cached or faked answer.

Every served health request is printed to stdout, unbuffered. The smoke greps those lines: a
`status=UP` row alone could be a lie, but a request that actually ARRIVED at the registered
instance cannot be. Registration uses Eureka's REST API and a heartbeat keeps the lease alive.

Env:
  INSIGHT_FIXTURE_APP    NEXUS-PLATFORM | NEXUS-AI   (required)
  INSIGHT_FIXTURE_PORT   the port this fixture listens on (required)
  INSIGHT_FIXTURE_PATH   api/v1/health | ai/v1/health (NO leading slash — see below)
  INSIGHT_FIXTURE_EUREKA e.g. http://127.0.0.1:18763/eureka/ (required)
"""

import json
import os
import sys
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# Git Bash's MSYS layer rewrites ANY environment value that starts with `/` into a Windows path
# when it hands it to a native process. Measured on this host: `INSIGHT_FIXTURE_PATH=/api/v1/health`
# arrived as `D:/BaiduNetdiskDownload/WorkBuddy/resources/vendor/PortableGit/api/v1/health`, so the
# fixture listened on the wrong path and every readiness ping got 404. Callers pass the path WITHOUT
# its leading slash; the slash is added HERE, inside Python, where no shell can rewrite it.
APP = os.environ['INSIGHT_FIXTURE_APP']
PORT = int(os.environ['INSIGHT_FIXTURE_PORT'])
HEALTH_PATH = '/' + os.environ['INSIGHT_FIXTURE_PATH'].lstrip('/')
EUREKA = os.environ['INSIGHT_FIXTURE_EUREKA'].rstrip('/') + '/'
INSTANCE_ID = f'{APP.lower()}:{PORT}'

# Guarded by assignment only; CPython's GIL makes a single-string swap atomic, and the point of
# the control endpoint is a visible change in the NEXT response, not a transactional one.
state = {'status': 'UP'}
_state_lock = threading.Lock()


def _request(method, url, payload=None):
    data = json.dumps(payload).encode('utf-8') if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    if data is not None:
        req.add_header('content-type', 'application/json')
    req.add_header('accept', 'application/json')
    with urllib.request.urlopen(req, timeout=3) as res:
        return res.status


def register():
    """Eureka's REST registration shape. `port.$` / `@enabled` are the JSON translation of the
    XML `port` element; `dataCenterInfo` must name Netflix's MyOwn class or the server rejects it."""
    body = {'instance': {
        'instanceId': INSTANCE_ID,
        'hostName': '127.0.0.1',
        'app': APP,
        'ipAddr': '127.0.0.1',
        'vipAddress': APP.lower(),
        'secureVipAddress': APP.lower(),
        'status': 'UP',
        'port': {'$': PORT, '@enabled': 'true'},
        'healthCheckUrl': f'http://127.0.0.1:{PORT}{HEALTH_PATH}',
        'statusPageUrl': f'http://127.0.0.1:{PORT}/__control/ping',
        'dataCenterInfo': {
            '@class': 'com.netflix.appinfo.InstanceInfo$DefaultDataCenterInfo',
            'name': 'MyOwn',
        },
        'leaseInfo': {'renewalIntervalInSecs': 5, 'durationInSecs': 30},
    }}
    for attempt in range(40):
        try:
            code = _request('POST', f'{EUREKA}apps/{APP}', body)
            if code in (200, 204):
                print(f'REGISTERED {APP} as {INSTANCE_ID} (HTTP {code})', flush=True)
                return True
        except (urllib.error.URLError, OSError) as exc:
            if attempt % 10 == 0:
                print(f'register retry {attempt}: {exc}', flush=True)
        time.sleep(0.5)
    print(f'REGISTRATION FAILED for {APP}', flush=True)
    return False


def heartbeat():
    while True:
        time.sleep(5)
        try:
            _request('PUT', f'{EUREKA}apps/{APP}/{INSTANCE_ID}')
        except (urllib.error.URLError, OSError):
            pass  # the smoke is short; a missed heartbeat is not a failed proof


class Handler(BaseHTTPRequestHandler):
    def _json(self, code, obj):
        body = json.dumps(obj).encode('utf-8')
        self.send_response(code)
        self.send_header('content-type', 'application/json; charset=utf-8')
        self.send_header('content-length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == HEALTH_PATH:
            with _state_lock:
                status = state['status']
            print(f'SERVE {self.path} status={status} app={APP}', flush=True)
            self._json(200, {'status': status, 'fixture': APP, 'instance': INSTANCE_ID})
            return
        if self.path == '/__control/ping':
            self._json(200, {'app': APP, 'instance': INSTANCE_ID, 'status': state['status']})
            return
        self._json(404, {'error': 'unknown fixture path', 'path': self.path})

    def do_POST(self):
        prefix = '/__control/status/'
        if self.path.startswith(prefix):
            wanted = self.path[len(prefix):].strip().upper()
            if not wanted or not wanted.replace('_', '').isalnum():
                self._json(400, {'error': 'status must be a plain token'})
                return
            with _state_lock:
                state['status'] = wanted
            print(f'CONTROL status -> {wanted}', flush=True)
            self._json(200, {'app': APP, 'status': wanted})
            return
        self._json(404, {'error': 'unknown control path', 'path': self.path})

    def log_message(self, *_args):
        pass


if __name__ == '__main__':
    if not register():
        sys.exit(1)
    threading.Thread(target=heartbeat, daemon=True).start()
    print(f'FIXTURE {APP} listening on :{PORT} for {HEALTH_PATH}', flush=True)
    ThreadingHTTPServer(('127.0.0.1', PORT), Handler).serve_forever()
