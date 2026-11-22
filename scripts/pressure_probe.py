"""D371 — the pressure probe: mass users, burst load, credential stuffing, capacity evidence.

§十一 of the product directive: simulate海量用户、高并发、瞬间大数据量, and record whether
the stack holds. Four legs against the live demo plane, each timed and counted:

  1. read load   — N concurrent workers hammering POST /ai/v1/search for `seconds`
  2. auth burst  — the §87 demo door hammered as fast as the pool allows
  3. stuffing    — wrong credentials repeated against the login-shaped door (the D-era
                   brute-force bucket is the expected answer, not a crash)
  4. spike       — a momentary burst of `burst` simultaneous requests from a cold start

Every leg reports: requests sent, HTTP responses by status, wall time, RPS, p50/p95/p99
latency, and the transport errors. The verdict is the evidence, not a pass/fail — the
numbers ARE the capacity statement this directive asks for.
"""

from __future__ import annotations

import concurrent.futures
import json
import statistics
import sys
import time
import urllib.error
import urllib.request

PLATFORM = "http://127.0.0.1:8090"
AI = "http://127.0.0.1:8010"
TENANT = "hong-kong"


def _request(url: str, data: bytes | None, timeout: float) -> tuple[int, float, str]:
    headers = {"x-tenant": TENANT}
    if data is not None:
        headers["content-type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers)
    t0 = time.monotonic()
    try:
        r = urllib.request.urlopen(req, timeout=timeout)
        r.read()
        return r.status, time.monotonic() - t0, ""
    except urllib.error.HTTPError as e:
        e.read()
        return e.code, time.monotonic() - t0, ""
    except Exception as exc:
        return 0, time.monotonic() - t0, str(exc)[:80]


def post(url: str, body: dict, timeout: float = 15.0) -> tuple[int, float, str]:
    return _request(url, json.dumps(body).encode("utf-8"), timeout)


def get(url: str, timeout: float = 15.0) -> tuple[int, float, str]:
    return _request(url, None, timeout)


def percentile(values: list[float], p: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    idx = min(len(ordered) - 1, max(0, round(p / 100 * (len(ordered) - 1))))
    return ordered[idx]


def run_leg(name: str, url: str, body: dict, workers: int, seconds: float) -> dict:
    statuses: dict[int | str, int] = {}
    latencies: list[float] = []
    sent = 0
    stop = time.monotonic() + seconds
    lock = __import__("threading").Lock()

    def worker() -> None:
        nonlocal sent
        while time.monotonic() < stop:
            status, latency, err = post(url, body)
            with lock:
                sent += 1
                key = err[:40] if err else status
                statuses[key] = statuses.get(key, 0) + 1
                latencies.append(latency)

    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        futures = [pool.submit(worker) for _ in range(workers)]
        for f in futures:
            f.result()

    wall = seconds
    rps = round(sent / wall, 1)
    p50 = round(percentile(latencies, 50) * 1000)
    p95 = round(percentile(latencies, 95) * 1000)
    p99 = round(percentile(latencies, 99) * 1000)
    errors = sum(v for k, v in statuses.items() if isinstance(k, str))
    print(f"{name}: sent={sent} wall={round(wall,1)}s rps={rps} p50={p50}ms p95={p95}ms p99={p99}ms "
          f"errors={errors} statuses={ {str(k): v for k, v in sorted(statuses.items(), key=lambda x: str(x[0]))} }")
    return {"sent": sent, "statuses": statuses, "rps": rps, "p50": p50, "p95": p95, "p99": p99}


if __name__ == "__main__":
    workers = int(sys.argv[1]) if len(sys.argv) > 1 else 12
    seconds = float(sys.argv[2]) if len(sys.argv) > 2 else 12.0
    print(f"pressure probe: workers={workers} seconds-per-leg={seconds} — platform {PLATFORM}, ai {AI}")

    print()
    print("leg 1 — read load: POST /ai/v1/search (keyword query, demo plane)")
    run_leg("read-load", f"{AI}/ai/v1/search",
            {"query": "餐廳", "geo": {"lat": 22.3809, "lng": 114.1861}, "limit": 10},
            workers, seconds)

    print()
    print("leg 2 — auth burst: POST /api/v1/auth/demo (the §87 demo door)")
    run_leg("auth-burst", f"{PLATFORM}/api/v1/auth/demo",
            {"role": "consumer"}, workers, seconds)

    print()
    print("leg 3 — credential stuffing: wrong passwords against the auth door")
    stuffing_results: dict[str, int] = {}
    stuffing_latencies: list[float] = []
    stop = time.monotonic() + seconds
    lock = __import__("threading").Lock()
    counters = {"sent": 0}

    def stuffer(index: int) -> None:
        while time.monotonic() < stop:
            password = f"wrong-pass-{index % 1000}"
            status, latency, err = post(f"{PLATFORM}/api/v1/auth/login",
                                        {"email": f"probe{index}@example.com", "password": password})
            with lock:
                counters["sent"] += 1
                key = err[:40] if err else status
                stuffing_results[key] = stuffing_results.get(key, 0) + 1
                stuffing_latencies.append(latency)
            time.sleep(0.01)

    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        futures = [pool.submit(stuffer, i) for i in range(workers)]
        for f in futures:
            f.result()
    wall = seconds
    print(f"stuffing: sent={counters['sent']} rps={round(counters['sent']/wall,1)} "
          f"p50={round(percentile(stuffing_latencies,50)*1000)}ms p95={round(percentile(stuffing_latencies,95)*1000)}ms "
          f"statuses={ {str(k): v for k, v in sorted(stuffing_results.items(), key=lambda x: str(x[0]))} }")

    print()
    print("leg 4 — spike: 200 simultaneous cold-start requests")
    spike_body = {"query": "test", "geo": {"lat": 22.3809, "lng": 114.1861}, "limit": 5}
    t0 = time.monotonic()
    with concurrent.futures.ThreadPoolExecutor(max_workers=200) as pool:
        results = list(pool.map(lambda _: post(f"{AI}/ai/v1/search", spike_body), range(200)))
    statuses: dict[str, int] = {}
    ok_latencies: list[float] = []
    for status, latency, err in results:
        key = err[:40] if err else status
        statuses[key] = statuses.get(key, 0) + 1
        if status == 200:
            ok_latencies.append(latency)
    wall = time.monotonic() - t0
    print(f"spike: 200 requests in {round(wall,2)}s rps={round(200/wall,1)} "
          f"ok={statuses.get(200,0)} statuses={ {str(k): v for k, v in sorted(statuses.items(), key=lambda x: str(x[0]))} } "
          f"ok-p50={round(percentile(ok_latencies,50)*1000)}ms ok-p95={round(percentile(ok_latencies,95)*1000)}ms")

    print()
    print("leg 5 — siege with civilians: stuffing flood while legitimate traffic keeps walking "
          "(D1537). The attacker and every civilian share one client IP on the demo plane, so the "
          "auth-scoped civilians (the demo door) are EXPECTED to be starved — that is the honest, "
          "documented trade-off of per-IP limiting (§1/§47), measured here instead of assumed away. "
          "What must NOT happen: a 5xx anywhere, and the unscoped read planes collapsing.")

    def civilian_auth(result: dict, lock, stop: float) -> None:
        while time.monotonic() < stop:
            status, latency, err = post(f"{PLATFORM}/api/v1/auth/demo", {"role": "consumer"})
            with lock:
                result["statuses"][err[:40] if err else status] = result["statuses"].get(err[:40] if err else status, 0) + 1
                result["latencies"].append(latency)
            time.sleep(0.05)

    def civilian_read(result: dict, lock, stop: float, url: str, body: dict | None) -> None:
        while time.monotonic() < stop:
            status, latency, err = get(url) if body is None else post(url, body)
            with lock:
                result["statuses"][err[:40] if err else status] = result["statuses"].get(err[:40] if err else status, 0) + 1
                result["latencies"].append(latency)
            time.sleep(0.02)

    siege = {
        "attack": {"statuses": {}, "latencies": []},
        "auth-civilian": {"statuses": {}, "latencies": []},
        "platform-read-civilian": {"statuses": {}, "latencies": []},
        "ai-read-civilian": {"statuses": {}, "latencies": []},
    }
    siege_stop = time.monotonic() + seconds
    siege_lock = __import__("threading").Lock()

    # The four populations share ONE clock and ONE stop line: the siege is simultaneous, not
    # interleaved legs — availability under attack is only measured while the attack is live.
    import threading as _threading

    def attack_loop(index: int) -> None:
        while time.monotonic() < siege_stop:
            status, latency, err = post(f"{PLATFORM}/api/v1/auth/login",
                                        {"email": f"siege{index}@example.com",
                                         "password": f"wrong-pass-{index % 1000}"})
            with siege_lock:
                siege["attack"]["statuses"][err[:40] if err else status] = \
                    siege["attack"]["statuses"].get(err[:40] if err else status, 0) + 1
                siege["attack"]["latencies"].append(latency)

    threads = [
        _threading.Thread(target=attack_loop, args=(i,), daemon=True) for i in range(workers)
    ] + [
        _threading.Thread(target=civilian_auth, args=(siege["auth-civilian"], siege_lock, siege_stop), daemon=True),
        _threading.Thread(target=civilian_read,
                          args=(siege["platform-read-civilian"], siege_lock, siege_stop,
                                f"{PLATFORM}/api/v1/health", None), daemon=True),
        _threading.Thread(target=civilian_read,
                          args=(siege["ai-read-civilian"], siege_lock, siege_stop,
                                f"{AI}/ai/v1/search",
                                {"query": "餐廳", "geo": {"lat": 22.3809, "lng": 114.1861}, "limit": 10}), daemon=True),
    ]
    siege_t0 = time.monotonic()
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    siege_wall = time.monotonic() - siege_t0

    verdict_ok = True
    for name, res in siege.items():
        total = sum(res["statuses"].values())
        five_xx = sum(v for k, v in res["statuses"].items() if isinstance(k, int) and k >= 500)
        transport = sum(v for k, v in res["statuses"].items() if isinstance(k, str))
        ok = sum(v for k, v in res["statuses"].items() if k == 200)
        limited = sum(v for k, v in res["statuses"].items() if k == 429)
        rejected = sum(v for k, v in res["statuses"].items() if k in (401, 403))
        p50 = round(percentile(res["latencies"], 50) * 1000)
        p95 = round(percentile(res["latencies"], 95) * 1000)
        rps = round(total / max(siege_wall, 0.001), 1)
        print(f"siege/{name}: sent={total} rps={rps} p50={p50}ms p95={p95}ms "
              f"ok={ok} limited(429)={limited} rejected(401/403)={rejected} 5xx={five_xx} transport={transport} "
              f"statuses={ {str(k): v for k, v in sorted(res['statuses'].items(), key=lambda x: str(x[0]))} }")
        if five_xx or transport:
            verdict_ok = False

    attack_statuses = siege["attack"]["statuses"]
    defense_fired = any(k == 429 for k in attack_statuses)
    if not defense_fired:
        print("VERDICT: WEAK — the stuffing flood never tripped a 429; the brute-force bucket did not answer.")
        verdict_ok = False
    else:
        print("VERDICT: defense fired — the stuffing flood met the auth bucket (429s) with zero 5xx."
              if verdict_ok else
              "VERDICT: defense fired, but a crash signal (5xx/transport) appeared — see the legs above.")
    print(f"siege wall: {round(siege_wall,1)}s — the stack is judged by these numbers, not by a pass/fail stamp.")
