'use client';

import { useEffect, useState } from 'react';

/**
 * D1279 — the live-model phrasing of the manual's answer, client-side and optional.
 *
 * The page renders the deterministic retrieval answer on the server; this island then asks
 * `/api/nexus/ai/handbook-ask` for the model's phrasing of the manual's own sections. On
 * success the model block appears (with a provenance badge; the deterministic answer stays
 * visible verbatim). On ANY failure — mock provider, no live upstream, timeout, a reply that
 * breaks the contract, or an empty answer — the island removes itself and the reader sees
 * exactly the deterministic render and nothing else.
 *
 * The island never blocks paint, never retries, never polls, and stores nothing.
 */
export function HandbookAskLive({
  question,
  locale,
  provenLabel,
  pendingLabel,
}: {
  question: string;
  locale: string;
  provenLabel: string;
  pendingLabel: string;
}) {
  const [state, setState] = useState<
    | { kind: 'pending' }
    | { kind: 'ready'; answer: string; citations: Array<{ id: string; title: string }> }
    | { kind: 'gone' }
  >({ kind: 'pending' });

  useEffect(() => {
    if (!question || question.length < 3) {
      setState({ kind: 'gone' });
      return;
    }
    const ctrl = new AbortController();
    fetch('/api/nexus/ai/handbook-ask', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question, locale }),
      signal: ctrl.signal,
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data && !data.degraded && typeof data.answer === 'string' && data.answer.trim() && Array.isArray(data.citations) && data.citations.length > 0) {
          setState({ kind: 'ready', answer: data.answer, citations: data.citations });
          return;
        }
        setState({ kind: 'gone' });
      })
      .catch(() => setState({ kind: 'gone' }));
    return () => ctrl.abort();
  }, [question, locale]);

  if (state.kind === 'gone') return null;

  if (state.kind === 'pending') {
    return (
      <p
        role="status"
        aria-live="polite"
        className="mt-4 text-2xs text-ink-faint"
      >
        {pendingLabel}
      </p>
    );
  }

  return (
    <div className="mt-4 flex flex-col gap-2 rounded-xl border border-accent-line bg-canvas p-4">
      <p className="text-2xs font-semibold uppercase tracking-wide text-accent">{provenLabel}</p>
      <p className="max-w-prose text-sm leading-relaxed text-ink-strong">{state.answer}</p>
      <ul className="grid gap-1.5 text-xs text-ink-muted">
        {state.citations.map((c) => (
          <li key={c.id}>
            §{' '}
            <a href={`#${c.id}`} className="underline underline-offset-2 hover:text-accent">
              {c.title}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
