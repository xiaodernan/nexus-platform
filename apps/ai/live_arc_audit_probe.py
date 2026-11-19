"""D1458/D1465 — the whole-arc continuity auditor, checked in for the operator to run deliberately.
Since D1465 the probe routes through `nexus_ai.orchestrator.arc_audit_graph` (assemble -> audit
-> verify): the model writes, the code fences (chapter numbers must exist in the window, no URLs,
no over-long fields, an all-invalid reply degrades to an empty audit). Nothing raw reaches the
operator as "findings".

The layer L->P continuity audit run on 2026-11-19 consumed a 58,957-prompt-token context and
returned usable contradictions (all later rejected as false positives — but the tool paid for
itself in signal). The arc now stands at 150 chapters in three arms; no single review pass can
hold them back-to-back. This probe hands the window to the model ONCE per run and returns:

  1. up to five cross-chapter inconsistencies (character drift, placed-wrong continuity, beat
     contradictions) — each carries a chapter number;
  2. one-sentence arc-level thematic reading;
  3. the single most unaddressed reader question at the head of this window.

Budget: ONE call through the factory/adapter pool, task_class 'reason', temperature 0, JSON only.
Cost: roughly 60K prompt tokens for the L->P span — this probe is NEVER part of a request path,
never automated, never on a schedule. Operator runs by hand. Saves THIS much spend only:

    NEXUS_LLM_PROVIDER=openai NEXUS_LLM_BASE_URL=https://api.aizzz.xyz/v1 \
    NEXUS_LLM_API_KEY=... NEXUS_LLM_MODEL_REASON=gpt-6.2-sol \
    NEXUS_LLM_PROXY=http://127.0.0.1:7897 \
    uv run python live_arc_audit_probe.py --from 109 --to 150

No key is committed anywhere. Exits 3 with setup instructions when unset. Never auto-finishes:
when it returns, it prints `prompt/cached/completion` and the arc's raw reply — nothing else.
"""
from __future__ import annotations

import argparse
import asyncio
import io
import json
import os
import re
import sys
import time
from pathlib import Path

SEED = Path(__file__).resolve().parent.parent / "web" / "src" / "lib" / "mock" / "seed.ts"

CN_DIGIT = {'一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9}
CN_MUL = {'十': 10, '百': 100, '千': 1000}


def cn_int(raw: str) -> int | None:
    total, cur = 0, 0
    for ch in raw:
        if ch == '零':
            continue
        if ch in CN_DIGIT:
            cur = cur * 10 + CN_DIGIT[ch]
        elif ch in CN_MUL:
            total += (cur or 1) * CN_MUL[ch]
            cur = 0
        else:
            return None
    return total + cur


def chapter_no(title: str) -> int | None:
    m = re.search(r'第([一二三四五六七八九十百零]{1,7})章', title)
    if not m:
        return None
    return cn_int(m.group(1))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--from', dest='start', type=int, default=109)
    ap.add_argument('--to', dest='end', type=int, default=150)
    args = ap.parse_args()

    if not (os.environ.get('NEXUS_LLM_BASE_URL') and os.environ.get('NEXUS_LLM_API_KEY')):
        print(__doc__)
        sys.exit(3)

    # checked at runtime so the git checkout never pulls in a dependency it does not own
    from nexus_ai.config import get_settings
    from nexus_ai.models.factory import get_pool, reset_provider_cache
    from nexus_ai.models.base import LLMRequest

    settings = get_settings()
    print('provider:', settings.llm_provider, '| proxy:', settings.llm_proxy or '(direct)')
    reset_provider_cache()
    pool = get_pool(settings)
    adapter = pool.get('openai') or pool.get('anthropic')
    if adapter is None:
        print('no live adapter from the configured environment — set NEXUS_LLM_PROVIDER=openai', file=sys.stderr)
        sys.exit(4)

    text = io.open(SEED, encoding='utf-8').read()
    entries: list[tuple[int, str, int]] = []
    for m in re.finditer(r"slug: '([a-z0-9-]+)', title: '([^']+)'", text):
        n = chapter_no(m.group(2))
        if n is not None and args.start <= n <= args.end:
            entries.append((n, m.group(2), m.start()))
    entries.sort(key=lambda r: r[0])
    if not entries:
        print(f'no chapters in [{args.start}, {args.end}] parsed from the seed')
        sys.exit(5)

    starts = [e[2] for e in entries]
    corpus_parts = []
    for i, (n, title, pos) in enumerate(entries):
        end = starts[i + 1] if i + 1 < len(starts) else len(text)
        corpus_parts.append(f'=== Chapter {n} :: {title} ===\n{text[pos:end]}')
    corpus = '\n\n'.join(corpus_parts)

    print(f'chapters assembled: {[n for n, _, _ in entries]}')
    print(f'corpus chars: {len(corpus)} (~{len(corpus) // 2:,} tokens)')
    print('One call, temperature 0. This is deliberate spending; nothing else is charged until you say so.')

    from nexus_ai.orchestrator.arc_audit_graph import run_arc_audit
    from nexus_ai.models.prefix_contract import contract_for

    measured: dict[str, object] = {}

    async def llm_call(system: str, prompt: str, max_tokens: int):
        started = time.perf_counter()
        req = LLMRequest(
            task_class='reason',
            payload={'window': f'{args.start}-{args.end}', 'chapters': [n for n, _, _ in entries]},
            system=contract_for('arc_audit', system),
            prompt=prompt,
            max_tokens=int(max_tokens),
            temperature=0.0,
            json_hint='json_object',
        )
        call = await adapter.complete(req)
        measured.update({
            'prompt_tokens': call.prompt_tokens,
            'completion_tokens': call.completion_tokens,
            'cached_tokens': call.cached_tokens,
            'cache_reported': bool(call.cache_reported),
            'latency_ms': int((time.perf_counter() - started) * 1000),
        })
        try:
            parsed = json.loads(call.text) if call.text else None
        except Exception:
            parsed = None
        return parsed if isinstance(parsed, dict) else None

    result = asyncio.run(run_arc_audit(start=args.start, end=args.end, llm_call=llm_call))
    print('\n--- graph result (fenced) ---')
    print(json.dumps(result, ensure_ascii=False, indent=2)[:3000])
    print('\n--- measured (one call) ---')
    print(json.dumps(measured, ensure_ascii=False))


if __name__ == '__main__':
    main()
