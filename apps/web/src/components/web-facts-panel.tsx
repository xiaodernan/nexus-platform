'use client';

/**
 * Real-world facts for the city behind the fiction (§九). One explicit click asks the
 * SSRF-guarded web-search tool for public reference rows; every row is labelled
 * third-party / low-confidence. No LLM tokens, no automatic call.
 */

import { useState } from 'react';
import { Icon } from '@nexus/ui';

export interface WebFactsCopy {
  eyebrow: string;
  title: string;
  intro: string;
  note: string;
  placeholder: string;
  cta: string;
  pending: string;
  degraded: string;
  empty: string;
}

interface Row {
  title: string;
  snippet: string;
  url: string;
  source: string;
  confidence: string;
}
interface Result {
  query: string;
  results: Row[];
  degraded: boolean;
  reason?: string;
  latency_ms?: number;
}

export function WebFactsPanel({ locale, copy }: { locale: string; copy: WebFactsCopy }) {
  const [query, setQuery] = useState(locale.startsWith('en') ? 'Happy Valley Racecourse' : '跑馬地');
  const [language, setLanguage] = useState(locale.startsWith('en') ? 'en' : 'zh');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);

  const ask = async () => {
    if (!query.trim()) return;
    setBusy(true);
    setResult(null);
    try {
      const res = await fetch('/api/nexus/ai/web-facts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query, language }),
      });
      setResult(await res.json() as Result);
    } catch {
      setResult({ query, results: [], degraded: true, reason: 'web_search_unavailable' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-label={copy.title} className="rounded-2xl border border-line bg-surface p-5 sm:p-6">
      <span className="text-2xs font-semibold uppercase tracking-[0.2em] text-accent">{copy.eyebrow}</span>
      <h2 className="mt-1 text-lg font-semibold tracking-tight text-ink-strong">{copy.title}</h2>
      <p className="mt-2 max-w-prose text-sm leading-relaxed text-ink-muted">{copy.intro}</p>
      <p className="mt-1 text-2xs leading-relaxed text-ink-faint">{copy.note}</p>
      <div className="mt-4 mb-2 flex items-center gap-2">
        <button
          type="button"
          onClick={() => setLanguage(language === 'zh' ? 'en' : 'zh')}
          className="rounded-full border border-line bg-canvas px-3 py-1 text-2xs font-medium text-ink-muted transition-colors hover:border-accent hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          {language === 'zh' ? 'EN' : '中文'}
        </button>
      </div>
      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void ask(); }}
          maxLength={120}
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
        <div className="mt-4">
          {result.degraded || !result.results.length ? (
            <p className="text-sm text-ink-muted">{copy.degraded}{result.reason ? ` · ${result.reason}` : ''}</p>
          ) : (
            <ul className="grid gap-2">
              {result.results.map((row, i) => (
                <li key={`${row.url}-${i}`} className="rounded-xl border border-line bg-canvas p-3">
                  <a href={row.url} target="_blank" rel="noreferrer noopener" className="text-sm font-semibold text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
                    {row.title}
                  </a>
                  <p className="mt-1 text-2xs leading-relaxed text-ink-muted">{row.snippet}</p>
                  <p className="mt-1 text-2xs text-ink-faint">{row.source} · {row.confidence}</p>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </section>
  );
}
