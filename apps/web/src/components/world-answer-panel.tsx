'use client';

/**
 * World Answer — ask one question across the whole 170-chapter corpus (§四 deep RAG).
 * The backend retrieves real chapter bodies and fences every citation; this island just
 * asks on an explicit click and shows the result. No automatic call, no token until asked.
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
}

interface Result {
  answer: string;
  confidence: string;
  chapters: number[];
  degraded: boolean;
  reason?: string;
}

export function WorldAnswerPanel({ locale, copy }: { locale: string; copy: WorldAnswerCopy }) {
  const [query, setQuery] = useState('');
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
        body: JSON.stringify({ query, locale }),
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
            </>
          )}
        </div>
      ) : null}
    </section>
  );
}
