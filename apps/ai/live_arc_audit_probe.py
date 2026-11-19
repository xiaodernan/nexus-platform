"""D1458 — the whole-arc continuity auditor, checked in for the operator to run deliberately.

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

    system = (
        'You are the continuity auditor for a synthetic Hong Kong arc written in three arms '
        '(Traditional HK, opencc-folded Simplified, full English). '
        'Read the supplied corpus ONCE. Output JSON ONLY with this shape:\n'
        '{"inconsistencies": [{"chapter_a": <int>, "chapter_b": <int>, "issue": "<one sentence>"} <= five items],\n'
        ' "thematic_line": "<one sentence arc-level reading>",\n'
        ' "head_reader_question": "<the single unaddressed question a careful reader still has at the top of this window>",\n'
        ' "confidence": "low|medium|high"}\n'
        'Hard rules: chapter numbers mandatory for every inconsistency; do not invent merchants, places or people; '
        'if none found, return an empty list rather than a plausible one.'
    )
    prompt = (
        f'Window: {args.start}-{args.end} of the arc.\n\n'
        f'CORPUS:\n{corpus}\n\n'
        'JSON only.'
    )

    async def run():
        started = time.perf_counter()
        req = LLMRequest(
            task_class='reason',
            payload={'window': f'{args.start}-{args.end}', 'chapters': [n for n, _, _ in entries]},
            system=system,
            prompt=prompt,
            max_tokens=1200,
            temperature=0.0,
            json_hint='json_object',
        )
        call = await adapter.complete(req)
        ms = int((time.perf_counter() - started) * 1000)
        print(f'\ncall: prompt_tokens={call.prompt_tokens} completion_tokens={call.completion_tokens} '
              f'cached_tokens={call.cached_tokens} cache_reported={bool(call.cache_reported)} latency_ms={ms}')
        print('\n--- raw reply (first 2500 chars) ---')
        print((call.text or '')[:2500])

    asyncio.run(run())


if __name__ == '__main__':
    main()
