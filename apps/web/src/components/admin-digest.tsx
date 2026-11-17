'use client';

import { useEffect, useState } from 'react';

export type AdminDigestLabels = {
  eyebrow: string;
  title: string;
  pending: string;
  proven: string;
};

export type AdminDigestEvents = {
  xlen: number | null;
  pending: number | null;
  consumers: number | null;
  disabled: boolean;
  degraded: boolean;
  recentCount: number;
  topTemplates: string[];
};

type Phase =
  | { kind: 'pending' }
  | { kind: 'ready'; reading: string; actions: Array<{ action: string; why: string }> }
  | { kind: 'gone' };

/**
 * D1285 — the operator's digest, phrased by the model and fenced by the counters.
 *
 * Mounts on /admin/system with the REAL aggregated counters as props (the exact numbers the
 * page renders). On ANY failure — signed-out caller, non-admin role, mock provider, unreachable
 * service, a number the model wrote that the counters do not contain — the card renders nothing;
 * the console keeps showing the counters alone, and nothing more.
 *
 * One POST on mount, no polling, no retry, no storage, nothing re-fetched.
 */
export function AdminDigest({
  events,
  locale,
  labels,
}: {
  events: AdminDigestEvents;
  locale: string;
  labels: AdminDigestLabels;
}) {
  const [phase, setPhase] = useState<Phase>({ kind: 'pending' });

  useEffect(() => {
    const ctrl = new AbortController();
    fetch('/api/nexus/admin/digest', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        events: {
          xlen: events.xlen,
          pending: events.pending,
          consumers: events.consumers,
          disabled: events.disabled,
          degraded: events.degraded,
          recentCount: events.recentCount,
          topTemplates: events.topTemplates,
        },
        locale,
      }),
      signal: ctrl.signal,
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        const reading = (data as { reading?: unknown } | null)?.reading;
        const actions = (data as { actions?: unknown } | null)?.actions;
        const degraded = (data as { degraded?: unknown } | null)?.degraded;
        if (data && degraded !== true && typeof reading === 'string' && reading.trim()) {
          setPhase({
            kind: 'ready',
            reading: reading.trim(),
            actions: Array.isArray(actions)
              ? actions
                  .filter((a): a is { action: string; why: string } => {
                    if (typeof a !== 'object' || a === null) return false;
                    const act = (a as { action?: unknown }).action;
                    return typeof act === 'string' && act.trim().length > 0;
                  })
                  .slice(0, 3)
                  .map((a) => ({ action: a.action.trim(), why: typeof a.why === 'string' ? a.why.trim() : '' }))
              : [],
          });
          return;
        }
        setPhase({ kind: 'gone' });
      })
      .catch(() => setPhase({ kind: 'gone' }));
    return () => ctrl.abort();
    // The island reads the counters it was rendered with; it never re-reads them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (phase.kind === 'gone') return null;

  if (phase.kind === 'pending') {
    return (
      <p role="status" aria-live="polite" className="text-2xs text-ink-faint">
        {labels.pending}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2 rounded-xl border border-accent-line bg-canvas p-4">
      <p className="text-2xs font-semibold uppercase tracking-wide text-accent">{labels.eyebrow}</p>
      <p className="text-sm font-medium text-ink-strong">{labels.title}</p>
      <p className="max-w-prose text-sm leading-relaxed text-ink-strong">{phase.reading}</p>
      {phase.actions.length > 0 ? (
        <ol className="grid gap-1.5 text-xs text-ink-muted">
          {phase.actions.map((item, index) => (
            <li key={index} className="flex gap-2">
              <span className="font-mono text-accent">{index + 1}.</span>
              <span>
                <span className="font-medium text-ink-strong">{item.action}</span>
                {item.why ? <span className="text-ink-faint"> — {item.why}</span> : null}
              </span>
            </li>
          ))}
        </ol>
      ) : null}
      <p className="text-2xs text-ink-faint">{labels.proven}</p>
    </div>
  );
}
