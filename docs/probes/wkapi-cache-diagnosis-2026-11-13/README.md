# WKAPI cache-hit diagnosis — 2026-11-13 (the frozen-prefix line)

**The question the operator asked:** why are cache hit rates so low on `wkapi.pro` / `gpt-6-sol`,
and why does the dashboard's "stream" view differ from the app's view?

**Runtime context:** today is 2026-11-13; all measurements are against `https://wkapi.pro/v1`
(chat completions, `stream=true` + `stream_options.include_usage=true`, temperature 0).

## The four diagnostics

| # | file | question |
|---|------|----------|
| 1 | `diagnostic_1_system_role.py` | Does the proxy count a large `system` message at all? |
| 2 | `diagnostic_2_json_role.py` | On the `json_object` path, is `system` forwarded or dropped? |
| 3 | `diagnostic_3_prefix_role.py` | Is the cacheable run the user-role prefix, exclusively? |
| 4 | `diagnostic_4_stability.py` | Is `prompt_tokens` accounting even stable for identical requests? |

## What we measured (all runs, today)

### Tiny prompts (`prompt_tokens` tens of tokens)
Identical bytes reported varying counts (e.g. `62, 73, 85, 69, 77, 67`). Accounting at that scale
is approximate, not a meter. Do not read hit-rate off small samples.

### Identical large prompts (full 9k-char payload, D1043-slim discipline)
```
5413 / 5413 / 5413 / 5413 prompt tokens every call
   0 / 5248 / 5248 / 5248 cached_tokens           (97% after the first)
```
The provider's caching is real, byte-wise, on the user-role prefix — and only the *stable* prefix
can hit. That is what D1043 (slimmer) and D1044 (SSE include_usage default) fixed in this repo.

### `system` role vs `user` role (6- to 21k-token bodies, identical bytes repeated)
Measured **twice** in consecutive (minutes-apart, same machine) sweeps:

| arm | sweep 1 | sweep 2 |
|---|---|---|
| `chat` + `system=BIG` | `cached=20022` (cold-hit!) · then `None` | `20022` · `20022` (100%) |
| `chat` + `user=BIG…` | `None` · `None` | `None` · `None` |
| `json` + `system=BIG` | `None` · then `21586` | `None` · `21586` |
| `json` + `user=BIG…` | `cached=None` · `5447/6314` family | `4419/6360` · `5258/6284` |

Honest reading: caching **works on this proxy, intermittently, in both roles**, and its
accounting flickers call-to-call even for identical bytes. No role is categorically unusable and
no role is categorically reliable:

* plain-chat `system` arms were the most consistent (100% on the consecutive sweep);
* JSON-mode arms flicker in both roles;
* usage accounting is approximate at the edges regardless (spreads of ±8% observed on identical bytes).

### The pre-D1050 conclusion that was wrong, and why it didn't matter
The parallel lane that built `prefix_contract.py` diagnosed (diagnostic 2's first read) "the proxy
drops the system role on JSON mode" — today's sweep contradicts it (`json system=BIG` reaches
`prompt=21589`). The diagnosis warped because the proxy's behavior is bursty: an arm that reads
cold in one minute reads warm in the next. **The frozen-prefix fix was nonetheless directionally
right** — what it needed was a measured, deterministic arm, not a theory.

## The deterministic answer this repo uses

1. **The app's wire shape matters (D1043)** — byte-identical slim payloads hit the user-role prefix cache.
2. **SSE transport default + usage accounting (D1044)** — the provider surfaces cache accounting every call.
3. **Byte-identical temperature-0 requests are replayed from Redis (D1047)** — 100% deterministic service, zero tokens, opt-in.
4. **The summary/intent heads ride a single frozen ~2.3k-token contract (D1050/D1052)** — the longest run that can exist on every request, shared across task classes. Default ON, `NEXUS_PREFIX_CONTRACT=off` restores the exact prior prompts. Its token economy is deliberate; its cache effect on this proxy is real but bursty (json arm), and it is *additive* to (3), not a replacement.

## The parallel lane's vanish (honest note, 2026-11-13 ~23:50–00:00)
The frozen-preamble work (contract module, tests, the `check_d1050_prefix_contract.mjs` reader,
two call-site wirings, and these four scratch probes) landed untracked between 23:47 and 23:52,
and was **removed from the working tree before any commit** — pipeline reverted, files deleted —
leaving no trace in git. The diagnostics left behind (this file) record what was known. The unit
was rebuilt from the evidence (D1052) with the same discipline: the frozen preamble is a literal;
byte-stability is pinned by tests; the off-switch restores prior behaviour exactly; the reader is
wired into CI line-171 and reddens on any drift.

## Reproducing a cache verdict today
```
cd apps/ai
NEXUS_LLM_PROVIDER=openai NEXUS_LLM_BASE_URL=https://wkapi.pro/v1 NEXUS_LLM_API_KEY=... \
  NEXUS_LLM_MODEL_MID=gpt-6-sol uv run python cache_probe.py
```
Look for: identical-burst cached on call ≥ 2; diverse-burst cached ≥ round 2 with the D1050 contract;
tiny-system calls expected to flicker (do not read them).
