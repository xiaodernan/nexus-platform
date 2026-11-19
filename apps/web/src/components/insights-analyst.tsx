'use client';

import { useEffect, useState } from 'react';

/**
 * D1451 — the analyst StateGraph, read aloud to the operator, client-side and optional.
 *
 * The page renders the deterministic ghosts on the server; this island asks the BFF for the
 * analyst's readout of the same numbers: verdict (rising / flat / falling), one forecast
 * sentence, the single variable to watch, and at most three measures — each tied to one
 * measured number. On success the panel appears with a provenance badge. On ANY failure —
 * mock provider, no live upstream, timeout, a contract mismatch, an invented number — the
 * island renders nothing. The deterministic ghosts stay exactly as they were.
 *
 * One POST on mount. No polling. No retry. No storage. Fail-closed.
 */
export function InsightsAnalyst({
  locale,
  copy,
}: {
  locale: string;
  copy: {
    hint: string;
    pending: string;
    proven: string;
    title: string;
    measuresLabel: string;
    watchLabel: string;
    verdictRising: string;
    verdictFlat: string;
    verdictFalling: string;
  };
}) {
  const [state, setState] = useState<
    | { kind: 'pending' }
    | {
        kind: 'ready';
        verdict: string;
        forecast: string;
        watch: string;
        measures: Array<{ action: string; why: string }>;
      }
    | { kind: 'gone' }
  >({ kind: 'pending' });

  useEffect(() => {
    const ctrl = new AbortController();
    fetch('/api/nexus/ai/insights-analyst', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ locale }),
      signal: ctrl.signal,
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data
            && !data.degraded
            && typeof data.forecast === 'string'
            && data.forecast.trim()
            && Array.isArray(data.measures)
            && data.measures.length > 0) {
          const measures = (data.measures as Array<{ action: unknown; why: unknown }>)
            .map((m) => ({
              action: typeof m?.action === 'string' ? m.action : '',
              why: typeof m?.why === 'string' ? m.why : '',
            }))
            .filter((m) => m.action.trim())
            .slice(0, 3);
          if (measures.length === 0) {
            setState({ kind: 'gone' });
            return;
          }
          setState({
            kind: 'ready',
            verdict: typeof data.verdict === 'string' ? data.verdict : 'flat',
            forecast: data.forecast,
            watch: typeof data.watch === 'string' ? data.watch : '',
            measures,
          });
          return;
        }
        setState({ kind: 'gone' });
      })
      .catch(() => setState({ kind: 'gone' }));
    return () => ctrl.abort();
  }, [locale]);

  if (state.kind === 'gone') return null;

  if (state.kind === 'pending') {
    return (
      <p
        role="status"
        aria-live="polite"
        className="mt-3 text-2xs text-ink-faint sm:mt-4"
      >
        {copy.pending}
      </p>
    );
  }

  const verdictLabel = state.verdict === 'rising'
    ? copy.verdictRising
    : state.verdict === 'falling'
      ? copy.verdictFalling
      : copy.verdictFlat;

  return (
    <section className="mt-3 overflow-hidden rounded-2xl border border-accent-line bg-canvas sm:mt-4">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line bg-accent-soft px-5 py-3">
        <h2 className="text-2xs font-semibold uppercase tracking-wide text-accent">{copy.title}</h2>
        <span className="rounded-full border border-accent-line bg-surface px-2.5 py-1 text-2xs font-medium text-ink-strong">
          {verdictLabel}
        </span>
      </div>
      <p className="max-w-prose text-xs leading-relaxed text-ink-muted">{copy.hint}</p>
      <div className="flex flex-col gap-3 p-5">
        <p className="max-w-prose text-sm leading-relaxed text-ink-strong">{state.forecast}</p>
        {state.watch.trim() ? (
          <p className="max-w-prose text-xs leading-relaxed text-ink-muted">
            <span className="font-semibold text-ink-strong">{copy.watchLabel} </span>
            {state.watch}
          </p>
        ) : null}
        <div>
          <p className="text-2xs font-semibold uppercase tracking-wide text-accent">{copy.measuresLabel}</p>
          <ol className="mt-2 flex flex-col gap-2">
            {state.measures.map((m, i) => (
              <li
                key={`${i}-${m.action}`}
                className="flex items-start gap-3 rounded-xl border border-line bg-surface px-4 py-3"
              >
                <span className="mt-0.5 font-mono text-xs font-semibold text-accent">{i + 1}.</span>
                <span className="flex flex-col gap-0.5">
                  <span className="text-sm leading-relaxed text-ink-strong">{m.action}</span>
                  <span className="text-2xs leading-relaxed text-ink-faint">{m.why}</span>
                </span>
              </li>
            ))}
          </ol>
        </div>
        <p className="border-t border-line pt-3 text-2xs leading-relaxed text-ink-faint">{copy.proven}</p>
      </div>
    </section>
  );
}
