'use client';

import { useEffect, useState } from 'react';

/**
 * D1280 — the model reads the ghost-replay aloud, client-side and optional.
 *
 * The page renders the deterministic ghosts on the server; this island asks the BFF
 * for a model phrasing of the same numbers. On success the paragraph + focus line appear
 * with a provenance badge. On ANY failure — mock provider, no live upstream, timeout, a
 * contract mismatch, a number that wasn't in the payload — the island renders nothing.
 * The deterministic ghosts stay exactly as they were.
 *
 * One POST on mount. No polling. No retry. No storage. Fail-closed.
 */
export function InsightsNarrative({
  locale,
  pendingLabel,
  provenLabel,
  focusLabel,
}: {
  locale: string;
  pendingLabel: string;
  provenLabel: string;
  focusLabel: string;
}) {
  const [state, setState] = useState<
    | { kind: 'pending' }
    | { kind: 'ready'; paragraph: string; focus: string }
    | { kind: 'gone' }
  >({ kind: 'pending' });

  useEffect(() => {
    const ctrl = new AbortController();
    fetch('/api/nexus/ai/insights-read', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ locale }),
      signal: ctrl.signal,
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data
            && !data.degraded
            && typeof data.paragraph === 'string'
            && data.paragraph.trim()
            && typeof data.focus === 'string'
            && data.focus.trim()) {
          setState({ kind: 'ready', paragraph: data.paragraph, focus: data.focus });
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
        {pendingLabel}
      </p>
    );
  }

  return (
    <div className="mt-3 flex flex-col gap-2 rounded-2xl border border-accent-line bg-canvas p-4 sm:mt-4">
      <p className="text-2xs font-semibold uppercase tracking-wide text-accent">{provenLabel}</p>
      <p className="max-w-prose text-sm leading-relaxed text-ink-strong">{state.paragraph}</p>
      <p className="max-w-prose text-sm leading-relaxed text-ink-strong">
        <span className="font-semibold text-ink-strong">{focusLabel}：</span>
        {state.focus}
      </p>
    </div>
  );
}
