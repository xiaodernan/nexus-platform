"""D980 — a live provider's `usage` is untrusted external input and must be bounded.

THE HOLE (measured against a REAL OpenAI-compatible proxy, 2026-11, model `gpt-6-sol`,
endpoint `https://wkapi.pro/v1`). The project's `OpenAIAdapter.complete` / `AnthropicAdapter.complete`
trusted the provider's `usage` verbatim and fed it straight into `cost_usd()` → `llm_calls.cost_usd`
(AGENT_CONTRACT §9 ledger). Two empirical observations on the live plane:

  * a request with `max_tokens=32` returned `completion_tokens=533` — 16x the ceiling the
    request itself imposed, physically impossible, yet billed as real;
  * the SAME short prompt returned `prompt_tokens` anywhere from 913 to 18481 across calls —
    non-deterministic, so the same logical request produced ~12x different `cost_usd`.

One implausible response can therefore inflate the cost/budget ledger by an arbitrary factor.
This is the same "unbounded trust in external input" class as D972/D974, on the billing plane.

THE FIX. `models/base.py::sanitize_usage(raw_pt, raw_ct, text, max_tokens)` bounds usage before it
reaches `cost_usd` or `LLMResponse`: completion is clamped to `[0, max_tokens]`, prompt to `>= 0`,
and a physically-implausible / non-numeric / missing-but-text value falls back to a local
`estimate_tokens` bound with `usage_flagged=True` so the ledger can distinguish a bounded estimate
from a trusted meter. Both adapters call it; honest in-range values pass through byte-for-byte.

WHAT THIS PROVES / DOES NOT. Pure offline (injected fake client, no network/DB/Redis). It proves the
bound holds, the real proxy shape is handled, honest usage is untouched, and the two live providers
are symmetric. The LIVE evidence itself is a separate, opt-in, key-env-only smoke (not a CI test) —
this probe is the runtime-independent door that keeps the fix green in CI without any key. It does
NOT assert any invoice truth (PRICE_PER_1K stays a dev estimate) or that any browser/provider ran.
"""

from __future__ import annotations

from nexus_ai.models.anthropic import AnthropicAdapter
from nexus_ai.models.base import LLMRequest, cost_usd, estimate_tokens, sanitize_usage
from nexus_ai.models.openai import OpenAIAdapter


class _Resp:
    def __init__(self, payload):
        self._payload = payload
        self.status_code = 200

    def raise_for_status(self):
        return None

    def json(self):
        return self._payload


class _Client:
    def __init__(self, resp):
        self.resp = resp
        self.calls = []

    async def post(self, url, headers=None, json=None):
        self.calls.append({"url": url, "headers": headers, "json": json})
        return self.resp


def _oai(payload):
    c = _Client(_Resp(payload))
    return OpenAIAdapter(base_url="http://x", api_key="k", client=c), c


def _anth(payload):
    c = _Client(_Resp(payload))
    return AnthropicAdapter(base_url="http://x", api_key="k", client=c), c


def _oai_payload(pt, ct, text="hi there"):
    return {"choices": [{"message": {"content": text}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": pt, "completion_tokens": ct}, "model": "gpt-6-sol"}


def _anth_payload(it, ot, text="hi there"):
    return {"content": [{"type": "text", "text": text}],
            "usage": {"input_tokens": it, "output_tokens": ot},
            "model": "claude-x", "stop_reason": "end_turn"}


class TestSanitizeUsagePure:
    def test_honest_in_range_usage_passes_through_unflagged(self):
        pt, ct, flagged = sanitize_usage(913, 12, "hi", max_tokens=32)
        assert (pt, ct, flagged) == (913, 12, False)

    def test_live_proxy_over_cap_completion_is_bounded_and_flagged(self):
        # The real observed shape: max_tokens=32 but completion_tokens=533.
        pt, ct, flagged = sanitize_usage(18481, 533, "hi", max_tokens=32)
        assert flagged is True
        assert 0 <= ct <= 32, "completion must never exceed the request ceiling"
        assert pt >= 0

    def test_negative_and_nonnumeric_usage_are_bounded(self):
        for raw in [(-5, -9), ("oops", 3), (None, 999), (8, "NaN")]:
            pt, ct, flagged = sanitize_usage(*raw, text="hi", max_tokens=16)
            assert flagged is True, raw
            assert pt >= 0 and 0 <= ct <= 16, raw

    def test_missing_usage_with_text_falls_back_to_local_estimate(self):
        pt, ct, flagged = sanitize_usage(0, 0, "a real answer with several words", max_tokens=64)
        assert flagged is True
        assert pt == estimate_tokens("a real answer with several words")
        assert ct == min(pt, 64)

    def test_zero_usage_without_text_is_not_flagged(self):
        # An empty completion legitimately has zero tokens — do not over-report.
        pt, ct, flagged = sanitize_usage(0, 0, "", max_tokens=32)
        assert (pt, ct, flagged) == (0, 0, False)


class TestAdapterWireBounds:
    async def test_openai_bills_a_bounded_cost_on_absurd_usage(self):
        o, c = _oai(_oai_payload(18481, 533))
        r = await o.complete(LLMRequest(task_class="summary", prompt="hi", max_tokens=32))
        assert r.usage_flagged is True
        assert r.completion_tokens <= 32
        # The ledger number is now bounded by the physical ceiling, not the absurd 533.
        assert r.cost_usd <= cost_usd("mid", estimate_tokens("hi there"), 32)
        assert r.text == "hi there" and r.degraded is False  # real answer untouched

    async def test_anthropic_is_symmetric(self):
        a, c = _anth(_anth_payload(10, 533))
        r = await a.complete(LLMRequest(task_class="summary", prompt="hi", max_tokens=32))
        assert r.usage_flagged is True
        assert r.completion_tokens <= 32
        assert r.cost_usd <= cost_usd("mid", estimate_tokens("hi there"), 32)

    async def test_honest_wire_usage_is_unchanged(self):
        # No regression against the existing wired contract (`test_live_adapters.py`):
        # an in-range usage still flows through verbatim and cost is computed from it.
        o, _ = _oai({"choices": [{"message": {"content": "hi there"}, "finish_reason": "stop"}],
                     "usage": {"prompt_tokens": 8, "completion_tokens": 3}, "model": "gpt-4o"})
        r = await o.complete(LLMRequest(task_class="summary", prompt="hi"))
        assert (r.prompt_tokens, r.completion_tokens) == (8, 3)
        assert r.usage_flagged is False
        assert r.cost_usd == cost_usd("mid", 8, 3)

    async def test_falsifier_unbounded_meter_would_inflate_cost(self):
        # ONE-VARIABLE control: the pre-D980 shape (`pt=usage.pt, ct=usage.ct` verbatim)
        # really does bill the absurd 533-token completion. Proves the detector is load-bearing,
        # not vacuously true because cost_usd happens to be small.
        unbounded_cost = cost_usd("mid", 18481, 533)
        o, _ = _oai(_oai_payload(18481, 533))
        r = await o.complete(LLMRequest(task_class="summary", prompt="hi", max_tokens=32))
        assert unbounded_cost > r.cost_usd * 5, "unbounded meter must be materially larger"
