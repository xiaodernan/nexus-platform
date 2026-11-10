#!/usr/bin/env python3
"""D884's fixture: a throwaway upstream that ECHOES the trace headers the gateway injected.

Never shipped as a service — `scripts/cloud_trace_smoke.sh` boots it on a spare port to answer the
one question a unit test cannot: what did the downstream actually RECEIVE after the edge filter?
It returns the `traceparent` and `X-Trace-Id` it saw as JSON, so the smoke can compare the wire with
the gateway's response headers instead of trusting either one alone. Port comes from $TRACE_PORT.
"""

import json
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class Handler(BaseHTTPRequestHandler):
    def _go(self):
        body = json.dumps({
            'fixture': True,
            'path': self.path,
            'traceparent': self.headers.get('traceparent'),
            'x_trace_id': self.headers.get('x-trace-id'),
            'x_request_id': self.headers.get('x-request-id'),
        }).encode('utf-8')
        sys.stdout.write(f'ECHO {self.path} traceparent={self.headers.get("traceparent")}\n')
        sys.stdout.flush()
        self.send_response(200)
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
    port = int(os.environ.get('TRACE_PORT', '18102'))
    print(f'trace echo fixture listening on :{port}', flush=True)
    ThreadingHTTPServer(('127.0.0.1', port), Handler).serve_forever()
