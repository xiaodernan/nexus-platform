#!/usr/bin/env python3
"""D875's fixture: a scripted, countable upstream that fails the first N requests per path.

Never shipped — used only by scripts/cloud_retry_smoke.sh to prove the gateway's Retry filter
recovers a transient 5xx. The contract this fixture serves:

  * path = /api/v1/health  -> HTTP 500 for hits 1..FAILS_FIRST, HTTP 200 from hit FAILS_FIRST+1 on
  * path = /ai/v1/health   -> HTTP 503 for the first hit, HTTP 200 after
  * everything else         -> HTTP 200, echoes the path as JSON

Every request prints one line `HIT <path> <code>` to stdout; the smoke greps those to assert the
exact call count against the gateway (3 through one GET /api/v1/health: 500 + 500 + 200, or 1 through
one POST /api/v1/health: never retried). Port comes from $FLAKY_PORT.
"""

import json
import os
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

FAILS_FIRST = int(os.environ.get('FLAKY_FAILS_FIRST', '2'))
hits = {}
hits_lock_time = {}


def next_code(path: str) -> int:
    n = hits.get(path, 0) + 1
    hits[path] = n
    hits_lock_time[path] = time.time()
    if path == '/api/v1/health':
        return 500 if n <= FAILS_FIRST else 200
    if path == '/ai/v1/health':
        return 503 if n == 1 else 200
    return 200


class Handler(BaseHTTPRequestHandler):
    # D995: the gateway's Netty client pools keep-alive connections. Under HTTP/1.0's
    # connection-close-per-response default, the socket dies on every reuse and the pooled
    # reader sees an abort — which the gateway reports as a timeout/exceptions and answers 503
    # instead of passing the fixture's response through. HTTP/1.1 + Content-Length (always set)
    # keeps the socket legitimately alive so the gateway's pool can reuse it, exactly like a real
    # origin server would serve it.
    protocol_version = 'HTTP/1.1'

    def _go(self):
        path = self.path
        code = next_code(path)
        body = json.dumps({'fixture': True, 'path': path, 'hit': hits[path]}).encode('utf-8')
        sys.stdout.write(f'HIT {path} {code}\n')
        sys.stdout.flush()
        self.send_response(code)
        self.send_header('content-type', 'application/json; charset=utf-8')
        self.send_header('content-length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    do_GET = _go
    do_POST = _go
    do_PUT = _go
    do_DELETE = _go

    def log_message(self, *_args):
        pass


if __name__ == '__main__':
    port = int(os.environ['FLAKY_PORT'])
    print(f'fixture listening on :{port} (fail-first={FAILS_FIRST})', flush=True)
    ThreadingHTTPServer(('127.0.0.1', port), Handler).serve_forever()
