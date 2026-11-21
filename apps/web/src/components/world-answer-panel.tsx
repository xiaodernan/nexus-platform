'use client';

/**
 * World Answer — ask one question across the whole 175-chapter corpus (§四 deep RAG).
 * The backend retrieves real chapter bodies and fences every citation; this island just
 * asks on an explicit click and shows the result. No automatic call, no token until asked.
 *
 * D1514: the reader owns a two-way context budget. "Quick" keeps the original 8-chapter
 * cost; "Deep" asks the server for up to 20 chapters / ~30k characters of real body text
 * for cross-chapter questions. The client only names a depth — the server owns the actual
 * char/token budget, so a hostile client cannot turn one click into a corpus-sized bill.
 */

import { useState } from 'react';
import { Icon } from '@nexus/ui';

export interface WorldAnswerCopy {
  eyebrow: string;
  title: string;
  intro: string;
  placeholder: string;
  cta: string;
  pending: string;
  degraded: string;
  sourceLabel: string;
  /** D1514: reader-owned context budget — quick keeps the original cost, deep reads more. */
  depthLabel: string;
  quickLabel: string;
  deepLabel: string;
  quickHint: string;
  deepHint: string;
  budgetLabel: (chars: number, chapters: number) => string;
  measuredLabel: (cached: number, prompt: number) => string;
}

interface Result {
  answer: string;
  confidence: string;
  chapters: number[];
  degraded: boolean;
  reason?: string;
  depth?: string;
  budget?: { limit: number; chunk_chars: number; body_chars: number };
  measured?: { cached_tokens: number; prompt_tokens: number; cache_reported: boolean };
}

type Depth = 'quick' | 'deep';

export function WorldAnswerPanel({ locale, copy }: { locale: string; copy: WorldAnswerCopy }) {
  const [query, setQuery] = useState('');
  const [depth, setDepth] = useState<Depth>('quick');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);

  const ask = async () => {
    if (!query.trim()) return;
    setBusy(true);
    setResult(null);
    try {
      const res = await fetch('/api/nexus/ai/world-answer', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query, locale, depth }),
      });
      setResult(await res.json() as Result);
    } catch {
      setResult({ answer: '', confidence: 'low', chapters: [], degraded: true, reason: 'ai_unavailable' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-label={copy.title} className="rounded-2xl border border-line bg-surface p-5 sm:p-6">
      <span className="text-2xs font-semibold uppercase tracking-[0.2em] text-accent">{copy.eyebrow}</span>
      <h2 className="mt-1 text-lg font-semibold tracking-tight text-ink-strong">{copy.title}</h2>
      <p className="mt-2 max-w-prose text-sm leading-relaxed text-ink-muted">{copy.intro}</p>

      {/* D1514: reader-owned budget, named not measured — the server clamps the real size. */}
      <fieldset className="mt-4">
        <legend className="text-xs font-semibold text-ink-strong">{copy.depthLabel}</legend>
        <div className="mt-2 flex flex-wrap gap-2">
          {(['quick', 'deep'] as const).map((d) => {
            const active = depth === d;
            const label = d === 'quick' ? copy.quickLabel : copy.deepLabel;
            return (
              <button
                key={d}
                type="button"
                aria-pressed={active}
                onClick={() => setDepth(d)}
                className={`rounded-full border px-4 py-1.5 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
                  active
                    ? 'border-accent bg-accent text-accent-ink'
                    : 'border-line bg-canvas text-ink-muted hover:text-ink-strong'
                }`}
              >
                {label}
              </button>
            );
          })}
        </div>
        <p className="mt-2 text-2xs leading-relaxed text-ink-faint">
          {depth === 'quick' ? copy.quickHint : copy.deepHint}
        </p>
      </fieldset>

      <div className="mt-4 flex flex-col gap-2 sm:flex-row">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void ask(); }}
          maxLength={200}
          placeholder={copy.placeholder}
          aria-label={copy.placeholder}
          className="min-w-0 flex-1 rounded-md border border-line bg-canvas px-3 py-2 text-sm text-ink-strong outline-none focus-visible:ring-2 focus-visible:ring-accent"
        />
        <button
          type="button"
          onClick={ask}
          disabled={busy || !query.trim()}
          className="inline-flex shrink-0 items-center justify-center gap-2 rounded-full bg-accent px-5 py-2 text-sm font-semibold text-accent-ink transition-colors hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-60"
        >
          {busy ? copy.pending : copy.cta}
          <Icon name="arrowRight" size={14} aria-hidden="true" />
        </button>
      </div>
      {result ? (
        <div className="mt-4 rounded-xl border border-line bg-canvas p-4">
          {result.degraded || !result.answer ? (
            <p className="text-sm text-ink-muted">{copy.degraded}{result.reason ? ` · ${result.reason}` : ''}</p>
          ) : (
            <>
              <p className="text-sm leading-relaxed text-ink-strong">{result.answer}</p>
              {result.chapters.length ? (
                <p className="mt-2 text-2xs text-ink-faint">
                  {copy.sourceLabel} {result.chapters.map((n) => `#${n}`).join(' · ')}
                </p>
              ) : null}
              {result.budget && result.budget.body_chars > 0 ? (
                <p className="mt-1 text-2xs text-ink-faint">
                  {copy.budgetLabel(result.budget.body_chars, result.budget.limit)}
                </p>
              ) : null}
              {result.measured?.cache_reported && result.measured.prompt_tokens > 0 ? (
                <p className="mt-1 text-2xs text-ink-faint">
                  {copy.measuredLabel(result.measured.cached_tokens, result.measured.prompt_tokens)}
                </p>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </section>
  );
}
